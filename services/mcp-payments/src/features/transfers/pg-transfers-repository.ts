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

const FEE_MERCHANT = 'Banco Demo';
const FEE_MEMO = 'Comisión por transferencia';

export class PgTransfersRepository implements TransfersRepository {
  constructor(private readonly pool: pg.Pool) {}

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

  async findReceipt(draftId: string): Promise<TransferReceipt | undefined> {
    const { rows } = await this.pool.query<TransferReceipt>(
      `SELECT ${RECEIPT_COLUMNS} FROM bank.transfers WHERE draft_id = $1`,
      [draftId],
    );
    return rows[0];
  }

  async claimTokenId(jti: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('INSERT INTO bank.used_jtis (jti) VALUES ($1) ON CONFLICT DO NOTHING', [
      jti,
    ]);
    return rowCount === 1;
  }

  async executeDraft(draftId: string, now: () => Date): Promise<ExecuteDraftOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const outcome = await this.executeLocked(client, draftId, now);
      await client.query(outcome.status === 'executed' ? 'COMMIT' : 'ROLLBACK');
      return outcome;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /** Runs inside a transaction holding the draft's row lock, so concurrent calls serialise per draft. */
  private async executeLocked(client: pg.PoolClient, draftId: string, clock: () => Date): Promise<ExecuteDraftOutcome> {
    const { rows } = await client.query<TransferDraft>(
      `SELECT ${DRAFT_COLUMNS} FROM bank.transfer_drafts WHERE id = $1 FOR UPDATE`,
      [draftId],
    );
    const draft = rows[0];
    if (draft?.status === 'executed') {
      const existing = await client.query<TransferReceipt>(
        `SELECT ${RECEIPT_COLUMNS} FROM bank.transfers WHERE draft_id = $1`,
        [draftId],
      );
      if (existing.rows[0]) return { status: 'already_executed', receipt: existing.rows[0] };
    }
    if (draft?.status !== 'pending') return { status: 'not_pending' };
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
      `INSERT INTO bank.transfers (id, draft_id, reference, executed_at) VALUES ($1, $2, $3, $4) RETURNING ${RECEIPT_COLUMNS}`,
      [`trf_${randomUUID()}`, draftId, `BD-${randomUUID().slice(0, 8).toUpperCase()}`, now],
    );
    return { status: 'executed', receipt: receipt.rows[0] as TransferReceipt };
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
