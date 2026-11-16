import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { BoundedTransaction, LOCK_NOT_AVAILABLE } from './bounded-transaction.js';
import type { Deadline } from './deadline.js';
import type {
  Beneficiary,
  Currency,
  ExecuteDraftOutcome,
  ExecuteDraftRefusal,
  ExecuteDraftRequest,
  SourceAccount,
  TransferDraft,
  TransferReceipt,
  TransfersRepository,
} from './transfers-repository.js';

const BENEFICIARY_COLUMNS = `id, customer_id AS "customerId", full_name AS "fullName", bank_name AS "bankName",
  account_ref AS "accountRef", currency`;

const TIMESTAMP = (column: string) => `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * The draft under its row lock, with the account and beneficiary the receipt names. Only the draft is locked here
 * (the debit locks the account). One read, so the receipt never needs a lookup after the commit.
 */
const LOCK_DRAFT_SQL = `
  SELECT d.id, d.customer_id AS "customerId", d.source_account_id AS "sourceAccountId",
         d.beneficiary_id AS "beneficiaryId", d.amount::text AS amount, d.fee::text AS fee, d.currency, d.status,
         ${TIMESTAMP('d.expires_at')} AS "expiresAt",
         a.alias AS "accountAlias", a.number AS "accountNumber",
         b.full_name AS "beneficiaryName", b.bank_name AS "beneficiaryBank", b.account_ref AS "beneficiaryAccountRef",
         b.currency AS "beneficiaryCurrency"
    FROM bank.transfer_drafts d
    JOIN bank.accounts a ON a.id = d.source_account_id
    JOIN bank.beneficiaries b ON b.id = d.beneficiary_id
   WHERE d.id = $1
     FOR UPDATE OF d`;

const TRANSFER_COLUMNS = `id AS "transferId", reference, ${TIMESTAMP('executed_at')} AS "executedAt"`;

/** How long one lock wait lasts at most; it never outlasts what is left of the call's deadline. */
const DEFAULT_LOCK_WAIT_MS = 5000;

const FEE_MERCHANT = 'Banco Demo';
const FEE_MEMO = 'Comisión por transferencia';

type LockedResource = 'draft' | 'account';

interface LockedDraft extends TransferDraft {
  accountAlias: string;
  accountNumber: string;
  beneficiaryName: string;
  beneficiaryBank: string;
  beneficiaryAccountRef: string;
  beneficiaryCurrency: Currency;
}

interface TransferRow {
  transferId: string;
  reference: string;
  executedAt: string;
}

/** A lock wait ran out; carries which row it was waiting on, so the answer can say so. The transaction rolls back. */
class LockWaitTimeout extends Error {
  constructor(
    readonly resource: LockedResource,
    cause: unknown,
  ) {
    super(`lock wait timed out on the ${resource} row`, { cause });
  }
}

const REFUSED_ON_LOCK: Record<LockedResource, ExecuteDraftRefusal> = {
  draft: 'execution_in_progress',
  account: 'account_busy',
};

const writesSomething = (outcome: ExecuteDraftOutcome): boolean =>
  outcome.status === 'executed' || (outcome.status === 'refused' && outcome.code === 'insufficient_funds');

const refused = (code: ExecuteDraftRefusal): ExecuteDraftOutcome => ({ status: 'refused', code });

const draftOf = (row: LockedDraft): TransferDraft => ({
  id: row.id,
  customerId: row.customerId,
  sourceAccountId: row.sourceAccountId,
  beneficiaryId: row.beneficiaryId,
  amount: row.amount,
  fee: row.fee,
  currency: row.currency,
  status: row.status,
  expiresAt: row.expiresAt,
});

/** The receipt, from the locked draft row and the transfer's own row: the same shape for a fresh run and a replay. */
const receiptOf = (row: LockedDraft, transfer: TransferRow): TransferReceipt => ({
  transferId: transfer.transferId,
  draftId: row.id,
  reference: transfer.reference,
  executedAt: transfer.executedAt,
  amount: row.amount,
  fee: row.fee,
  currency: row.currency,
  sourceAccount: { id: row.sourceAccountId, alias: row.accountAlias, number: row.accountNumber },
  beneficiary: {
    id: row.beneficiaryId,
    fullName: row.beneficiaryName,
    bankName: row.beneficiaryBank,
    accountRef: row.beneficiaryAccountRef,
    currency: row.beneficiaryCurrency,
  },
});

/** Runs a statement that may wait for a row lock; a lock wait that ran out is named by the row it waited on. */
async function waitingOn<T>(resource: LockedResource, run: Promise<T>): Promise<T> {
  try {
    return await run;
  } catch (error) {
    if ((error as { code?: string }).code === LOCK_NOT_AVAILABLE) throw new LockWaitTimeout(resource, error);
    throw error;
  }
}

export interface PgTransfersOptions {
  lockWaitMs?: number;
}

export class PgTransfersRepository implements TransfersRepository {
  private readonly lockWaitMs: number;

  constructor(
    private readonly pool: pg.Pool,
    { lockWaitMs = DEFAULT_LOCK_WAIT_MS }: PgTransfersOptions = {},
  ) {
    this.lockWaitMs = lockWaitMs;
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

  async executeDraft({ deadline, ...request }: ExecuteDraftRequest, now: () => Date): Promise<ExecuteDraftOutcome> {
    const client = await this.connect(deadline);
    if (!client) return refused('not_executed');
    const tx = new BoundedTransaction(client, deadline, this.lockWaitMs);
    let discard: Error | undefined;
    try {
      await tx.begin();
      const outcome = await this.executeLocked(tx, request, now);
      // Only an execution and `insufficient_funds` (which wrote the spent token) commit. Every other answer wrote
      // nothing, so it rolls back and the commit-time deadline check cannot turn it into `not_executed`.
      if (!writesSomething(outcome)) {
        await client.query('ROLLBACK');
        return outcome;
      }
      await tx.commit();
      return outcome;
    } catch (error) {
      const rollbackError = await client.query('ROLLBACK').then(
        () => undefined,
        (failure: Error) => failure,
      );
      const refusal = refusalFor(tx, error);
      // A refusal leaves a healthy connection; any other failure may not, so the pool drops it.
      discard = rollbackError ?? (refusal ? undefined : (error as Error));
      if (refusal) return refused(refusal);
      throw error;
    } finally {
      client.release(discard);
    }
  }

  /** A connection within the deadline, or none: nothing has been sent yet, so the caller ran nothing. */
  private async connect(deadline: Deadline): Promise<pg.PoolClient | undefined> {
    if (deadline.remainingMs() < 1) return undefined;
    const pending = this.pool.connect();
    try {
      return await deadline.bound(pending);
    } catch {
      // A connection that arrives after the call gave up goes straight back.
      void pending.then(
        (late) => late.release(),
        () => undefined,
      );
      return undefined;
    }
  }

  /** Runs inside a transaction holding the draft's row lock, so concurrent calls serialise per draft. */
  private async executeLocked(
    tx: BoundedTransaction,
    { draftId, customerId, jti, isAuthorised }: Omit<ExecuteDraftRequest, 'deadline'>,
    clock: () => Date,
  ): Promise<ExecuteDraftOutcome> {
    const { rows } = await waitingOn('draft', tx.query<LockedDraft>(LOCK_DRAFT_SQL, [draftId]));
    const locked = rows[0];
    if (locked?.customerId !== customerId) return refused('draft_not_found');
    const draft = draftOf(locked);
    if (!isAuthorised(draft)) return refused('not_authorised');
    if (draft.status === 'executed') return this.replay(tx, locked, jti);
    if (draft.status !== 'pending') return refused('draft_not_pending');
    const now = clock(); // After the lock: the wait for it may have outlived the draft.
    // Before the token is looked at: an expired draft can never execute, so a spent token on it answers
    // `draft_expired`, and a new one is not spent for nothing.
    if (new Date(draft.expiresAt).getTime() <= now.getTime()) return refused('draft_expired');
    if (!(await this.spendToken(tx, jti, draftId))) return refused('token_already_used');
    const debit = await waitingOn(
      'account',
      tx.query(
        `UPDATE bank.accounts SET balance = balance - ($1::numeric + $2::numeric)
          WHERE id = $3 AND balance >= $1::numeric + $2::numeric`,
        [draft.amount, draft.fee, draft.sourceAccountId],
      ),
    );
    if (debit.rowCount !== 1) return refused('insufficient_funds');
    await this.recordMovements(tx, draft, now);
    await tx.query(`UPDATE bank.transfer_drafts SET status = 'executed' WHERE id = $1`, [draftId]);
    const { rows: transfers } = await tx.query<TransferRow>(
      `INSERT INTO bank.transfers (id, draft_id, step_up_jti, reference, executed_at) VALUES ($1, $2, $3, $4, $5)
       RETURNING ${TRANSFER_COLUMNS}`,
      [`trf_${randomUUID()}`, draftId, jti, `BD-${randomUUID().slice(0, 8).toUpperCase()}`, now],
    );
    return { status: 'executed', receipt: receiptOf(locked, transfers[0] as TransferRow) };
  }

  /** False when the token was spent before: by an attempt that moved nothing, since the draft is still pending. */
  private async spendToken(tx: BoundedTransaction, jti: string, draftId: string): Promise<boolean> {
    const { rowCount } = await tx.query(
      'INSERT INTO bank.used_jtis (jti, draft_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [jti, draftId],
    );
    return rowCount === 1;
  }

  /**
   * Answers a call on an executed draft from the record of that execution. A token nothing has spent gets the
   * receipt and stays unspent: it can authorise nothing on a draft that is done.
   */
  private async replay(tx: BoundedTransaction, locked: LockedDraft, jti: string): Promise<ExecuteDraftOutcome> {
    const { rows } = await tx.query<TransferRow & { executedByThisToken: boolean; tokenSpent: boolean }>(
      `SELECT ${TRANSFER_COLUMNS}, step_up_jti = $2 AS "executedByThisToken",
              EXISTS (SELECT 1 FROM bank.used_jtis WHERE jti = $2) AS "tokenSpent"
         FROM bank.transfers WHERE draft_id = $1`,
      [locked.id, jti],
    );
    const found = rows[0];
    if (!found || (found.tokenSpent && !found.executedByThisToken)) return refused('draft_not_pending');
    return { status: 'already_executed', receipt: receiptOf(locked, found) };
  }

  /** One row per movement, so the account's history adds up to what was debited (amount + fee). */
  private async recordMovements(tx: BoundedTransaction, draft: TransferDraft, now: Date): Promise<void> {
    await tx.query(
      `INSERT INTO bank.transactions (account_id, booked_at, amount, category, merchant, memo)
       SELECT $1, $2, -$3::numeric, 'transferencias', b.full_name, 'Transferencia enviada'
         FROM bank.beneficiaries b WHERE b.id = $4`,
      [draft.sourceAccountId, now, draft.amount, draft.beneficiaryId],
    );
    await tx.query(
      `INSERT INTO bank.transactions (account_id, booked_at, amount, category, merchant, memo)
       SELECT $1, $2, -$3::numeric, 'comisiones', $4, $5 WHERE $3::numeric > 0`,
      [draft.sourceAccountId, now, draft.fee, FEE_MERCHANT, FEE_MEMO],
    );
  }
}

/**
 * The definite answer to a failure before the commit was sent, or undefined when it is an error. A deadline that ran
 * out (before a statement, or cancelling one the armed timeouts cut off) means nothing ran; a lock wait that ended at
 * its own limit means another call holds that row.
 */
function refusalFor(tx: BoundedTransaction, error: unknown): ExecuteDraftRefusal | undefined {
  // Another call holds the draft whether or not the deadline has also run out, so it is classified first.
  if (error instanceof LockWaitTimeout && error.resource === 'draft') return REFUSED_ON_LOCK.draft;
  const cause = error instanceof LockWaitTimeout ? error.cause : error;
  if (tx.deadlineRanOut(cause)) return 'not_executed';
  return error instanceof LockWaitTimeout ? REFUSED_ON_LOCK[error.resource] : undefined;
}
