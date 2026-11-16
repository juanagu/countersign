import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import type {
  AuthorisedTransfer,
  Beneficiary,
  ExecuteDraftOutcome,
  ExecuteDraftRefusal,
  ExecuteDraftRequest,
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
/** The budget's `statement_timeout` can fire a moment before the capped `lock_timeout` it equals. */
const QUERY_CANCELED = '57014';
const WAIT_TIMEOUT_CODES = new Set([LOCK_NOT_AVAILABLE, QUERY_CANCELED]);
/** How long one lock wait lasts at most, and it never outlasts what is left of the execution's budget. */
const DEFAULT_LOCK_WAIT_MS = 5000;
/**
 * The whole execution, from asking the pool for a connection to the commit, bounded below the gateway's 10 s
 * backend timeout (ADR 023): the waits cannot add up past it, so the caller is not left guessing whether the
 * transfer committed after the gateway gave up.
 */
export const DEFAULT_EXECUTION_BUDGET_MS = 7000;

const FEE_MERCHANT = 'Banco Demo';
const FEE_MEMO = 'Comisión por transferencia';

type LockedResource = 'draft' | 'account';

/** A lock wait ran out; carries which row it was waiting on, so the answer can say so. */
class LockWaitTimeout extends Error {
  constructor(readonly resource: LockedResource) {
    super(`lock wait timed out on the ${resource} row`);
  }
}

const REFUSED_ON_LOCK: Record<LockedResource, ExecuteDraftRefusal> = {
  draft: 'execution_in_progress',
  account: 'account_busy',
};

const refused = (code: ExecuteDraftRefusal): ExecuteDraftOutcome => ({ status: 'refused', code });

function matchesAuthorised(draft: TransferDraft, authorised: AuthorisedTransfer): boolean {
  return (
    draft.amount === authorised.amount &&
    draft.currency === authorised.currency &&
    draft.beneficiaryId === authorised.beneficiaryId
  );
}

export interface PgTransfersOptions {
  lockWaitMs?: number;
  executionBudgetMs?: number;
}

export class PgTransfersRepository implements TransfersRepository {
  private readonly lockWaitMs: number;
  private readonly executionBudgetMs: number;

  constructor(
    private readonly pool: pg.Pool,
    { lockWaitMs = DEFAULT_LOCK_WAIT_MS, executionBudgetMs = DEFAULT_EXECUTION_BUDGET_MS }: PgTransfersOptions = {},
  ) {
    this.lockWaitMs = lockWaitMs;
    this.executionBudgetMs = executionBudgetMs;
  }

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

  async executeDraft(request: ExecuteDraftRequest, now: () => Date): Promise<ExecuteDraftOutcome> {
    const deadline = performance.now() + this.executionBudgetMs;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const outcome = await this.executeLocked(client, request, now, deadline);
      await this.limitWaits(client, deadline);
      // A refused attempt commits too: `insufficient_funds` wrote the spent token, which is what makes a stale one
      // answer `token_already_used`; the other refusals wrote nothing.
      await client.query('COMMIT');
      return outcome;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (error instanceof LockWaitTimeout) return refused(REFUSED_ON_LOCK[error.resource]);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Caps the next lock wait and statement at what is left of the budget, so the waits of one execution add up to
   * no more than the budget. Local to the transaction.
   */
  private async limitWaits(client: pg.PoolClient, deadline: number): Promise<void> {
    const remaining = Math.max(1, Math.floor(deadline - performance.now()));
    await client.query(`SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)`, [
      `${Math.min(this.lockWaitMs, remaining)}ms`,
      `${remaining}ms`,
    ]);
  }

  /** Waits for a row lock inside `run`; either timeout means the wait ran out, and the caller rolls back. */
  private async waitingOn<T>(resource: LockedResource, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (WAIT_TIMEOUT_CODES.has((error as { code?: string }).code ?? '')) throw new LockWaitTimeout(resource);
      throw error;
    }
  }

  /** Runs inside a transaction holding the draft's row lock, so concurrent calls serialise per draft. */
  private async executeLocked(
    client: pg.PoolClient,
    { draftId, jti, authorised }: ExecuteDraftRequest,
    clock: () => Date,
    deadline: number,
  ): Promise<ExecuteDraftOutcome> {
    await this.limitWaits(client, deadline);
    const { rows } = await this.waitingOn('draft', () =>
      client.query<TransferDraft>(`SELECT ${DRAFT_COLUMNS} FROM bank.transfer_drafts WHERE id = $1 FOR UPDATE`, [
        draftId,
      ]),
    );
    const draft = rows[0];
    if (!draft) return refused('draft_not_pending');
    if (!matchesAuthorised(draft, authorised)) return refused('not_authorised');
    if (draft.status === 'executed') return this.replay(client, draftId, jti);
    if (draft.status !== 'pending') return refused('draft_not_pending');
    const now = clock(); // After the lock: the wait for it may have outlived the draft.
    // Before the token is looked at: an expired draft can never execute, so a spent token on it answers
    // `draft_expired`, and a new one is not spent for nothing.
    if (new Date(draft.expiresAt).getTime() <= now.getTime()) return refused('draft_expired');
    await this.limitWaits(client, deadline);
    if (!(await this.spendToken(client, jti, draftId))) return refused('token_already_used');
    await this.limitWaits(client, deadline);
    const debit = await this.waitingOn('account', () =>
      client.query(
        `UPDATE bank.accounts SET balance = balance - ($1::numeric + $2::numeric)
          WHERE id = $3 AND balance >= $1::numeric + $2::numeric`,
        [draft.amount, draft.fee, draft.sourceAccountId],
      ),
    );
    if (debit.rowCount !== 1) return refused('insufficient_funds');
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
    const { rows: tokens } = await client.query<{ executedByThisToken: boolean; tokenSpent: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM bank.transfers WHERE draft_id = $1 AND step_up_jti = $2) AS "executedByThisToken",
              EXISTS (SELECT 1 FROM bank.used_jtis WHERE jti = $2) AS "tokenSpent"`,
      [draftId, jti],
    );
    const { rows: receipts } = await client.query<TransferReceipt>(
      `SELECT ${RECEIPT_COLUMNS} FROM bank.transfers WHERE draft_id = $1`,
      [draftId],
    );
    const receipt = receipts[0];
    const token = tokens[0];
    if (!receipt || !token || (token.tokenSpent && !token.executedByThisToken)) return refused('draft_not_pending');
    return { status: 'already_executed', receipt };
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
