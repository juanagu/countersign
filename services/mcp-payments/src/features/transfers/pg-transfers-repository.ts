import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  Beneficiary,
  ExecuteDraftOutcome,
  SourceAccount,
  TransferDraft,
  TransferReceipt,
  TransfersRepository,
} from './transfers-repository.js';

const DRAFT_COLUMNS = `id, customer_id AS "customerId", source_account_id AS "sourceAccountId",
  beneficiary_id AS "beneficiaryId", amount::text AS amount, fee::text AS fee, currency, status,
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "expiresAt"`;

const RECEIPT_COLUMNS = `id AS "transferId", draft_id AS "draftId", reference,
  to_char(executed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "executedAt"`;

const BENEFICIARY_COLUMNS = `id, customer_id AS "customerId", full_name AS "fullName", bank_name AS "bankName",
  account_ref AS "accountRef", currency`;

const LOCK_NOT_AVAILABLE = '55P03';
/** How long an execution waits for the draft's row lock before failing closed as `in_progress`. */
const DEFAULT_LOCK_WAIT_MS = 5000;

const FEE_MERCHANT = 'Banco Demo';
const FEE_MEMO = 'Comisión por transferencia';

export class PgTransfersRepository implements TransfersRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly lockWaitMs = DEFAULT_LOCK_WAIT_MS,
  ) {}

  async listBeneficiaries(customerId: string): Promise<Beneficiary[]> {
    const { rows } = await this.pool.query<Beneficiary>(
      `SELECT ${BENEFICIARY_COLUMNS} FROM bank.beneficiaries WHERE customer_id = $1 ORDER BY full_name`,
      [customerId],
    );
    return rows;
  }

  async findBeneficiary(id: string): Promise<Beneficiary | undefined> {
    const { rows } = await this.pool.query<Beneficiary>(
      `SELECT ${BENEFICIARY_COLUMNS} FROM bank.beneficiaries WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async findAccount(id: string): Promise<SourceAccount | undefined> {
    const { rows } = await this.pool.query<SourceAccount>(
      `SELECT id, customer_id AS "customerId", currency, alias, number, balance::text AS balance
         FROM bank.accounts WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async createDraft(d: TransferDraft): Promise<void> {
    await this.pool.query(
      `INSERT INTO bank.transfer_drafts
         (id, customer_id, source_account_id, beneficiary_id, amount, currency, fee, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [d.id, d.customerId, d.sourceAccountId, d.beneficiaryId, d.amount, d.currency, d.fee, d.status, d.expiresAt],
    );
  }

  async findDraft(id: string): Promise<TransferDraft | undefined> {
    const { rows } = await this.pool.query<TransferDraft>(
      `SELECT ${DRAFT_COLUMNS} FROM bank.transfer_drafts WHERE id = $1`,
      [id],
    );
    return rows[0];
  }

  async executeDraft(draftId: string, jti: string, now: () => Date): Promise<ExecuteDraftOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${this.lockWaitMs}ms`]);
      const outcome = await this.executeLocked(client, draftId, jti, now);
      // A refused attempt commits too: it wrote only the spent token, which is what makes a stale one answer
      // `token_already_used`. `in_progress` rolled back before it wrote anything.
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) return { status: 'in_progress' };
      throw error;
    } finally {
      client.release();
    }
  }

  /** Runs inside a transaction holding the draft's row lock, so concurrent calls serialise per draft. */
  private async executeLocked(
    client: pg.PoolClient,
    draftId: string,
    jti: string,
    clock: () => Date,
  ): Promise<ExecuteDraftOutcome> {
    const { rows } = await client.query<TransferDraft>(
      `SELECT ${DRAFT_COLUMNS} FROM bank.transfer_drafts WHERE id = $1 FOR UPDATE`,
      [draftId],
    );
    const draft = rows[0];
    if (draft?.status === 'executed') return this.replay(client, draftId, jti);
    if (draft?.status !== 'pending') return { status: 'not_pending' };
    if (!(await this.spendToken(client, jti, draftId))) return { status: 'token_already_used' };
    const now = clock(); // After the lock: the wait for it may have outlived the draft.
    if (new Date(draft.expiresAt).getTime() <= now.getTime()) return { status: 'expired' };
    const debit = await client.query(
      `UPDATE bank.accounts SET balance = balance - ($1::numeric + $2::numeric)
        WHERE id = $3 AND balance >= $1::numeric + $2::numeric`,
      [draft.amount, draft.fee, draft.sourceAccountId],
    );
    if (debit.rowCount !== 1) return { status: 'insufficient_funds' };
    await this.recordMovements(client, draft, now);
    await client.query(`UPDATE bank.transfer_drafts SET status = 'executed' WHERE id = $1`, [draftId]);
    const receipt = await client.query<TransferReceipt>(
      `INSERT INTO bank.transfers (id, draft_id, step_up_jti, reference, executed_at) VALUES ($1, $2, $3, $4, $5)
       RETURNING ${RECEIPT_COLUMNS}`,
      [`trf_${randomUUID()}`, draftId, jti, `BD-${randomUUID().slice(0, 8).toUpperCase()}`, now],
    );
    return { status: 'executed', receipt: receipt.rows[0] as TransferReceipt };
  }

  /** False when the token was spent before: by an attempt that moved nothing, since the draft is still pending. */
  private async spendToken(client: pg.PoolClient, jti: string, draftId: string): Promise<boolean> {
    const { rowCount } = await client.query(
      'INSERT INTO bank.used_jtis (jti, draft_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [jti, draftId],
    );
    return rowCount === 1;
  }

  /**
   * Answers a call on an executed draft from the record of that execution. A token nothing has spent gets the
   * receipt and stays unspent: it can authorise nothing on a draft that is done.
   */
  private async replay(client: pg.PoolClient, draftId: string, jti: string): Promise<ExecuteDraftOutcome> {
    const { rows } = await client.query<TransferReceipt & { executedByThisToken: boolean; tokenSpent: boolean }>(
      `SELECT ${RECEIPT_COLUMNS}, t.step_up_jti = $2 AS "executedByThisToken",
              EXISTS (SELECT 1 FROM bank.used_jtis WHERE jti = $2) AS "tokenSpent"
         FROM bank.transfers t WHERE t.draft_id = $1`,
      [draftId, jti],
    );
    const row = rows[0];
    if (!row || (row.tokenSpent && !row.executedByThisToken)) return { status: 'not_pending' };
    const { transferId, draftId: executedDraftId, reference, executedAt } = row;
    return { status: 'already_executed', receipt: { transferId, draftId: executedDraftId, reference, executedAt } };
  }

  /** One row per movement, so the account's history adds up to what was debited (amount + fee). */
  private async recordMovements(client: pg.PoolClient, draft: TransferDraft, now: Date): Promise<void> {
    await client.query(
      `INSERT INTO bank.transactions (account_id, booked_at, amount, category, merchant, memo)
       SELECT $1, $2, -$3::numeric, 'transferencias', b.full_name, 'Transferencia enviada'
         FROM bank.beneficiaries b WHERE b.id = $4`,
      [draft.sourceAccountId, now, draft.amount, draft.beneficiaryId],
    );
    await client.query(
      `INSERT INTO bank.transactions (account_id, booked_at, amount, category, merchant, memo)
       SELECT $1, $2, -$3::numeric, 'comisiones', $4, $5 WHERE $3::numeric > 0`,
      [draft.sourceAccountId, now, draft.fee, FEE_MERCHANT, FEE_MEMO],
    );
  }
}
