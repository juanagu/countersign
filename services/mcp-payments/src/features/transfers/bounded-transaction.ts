import type pg from 'pg';
import { DeadlineExceeded, type Deadline } from './deadline.js';

/** What a lock wait that hit `lock_timeout` raises. */
export const LOCK_NOT_AVAILABLE = '55P03';
/** What a statement cancelled by `statement_timeout` raises. */
export const STATEMENT_TIMEOUT = '57014';

/**
 * One transaction whose every statement runs inside a deadline: before each one it reads what is left, refuses to
 * start with nothing left (`DeadlineExceeded`, before anything of that statement was sent), and otherwise arms
 * `statement_timeout` and `lock_timeout` to what is left, so the statements of one call add up to no more than it.
 * The commit gets no statement timeout: cancelling it would leave the outcome unknown for a transaction that was fine.
 */
export class BoundedTransaction {
  constructor(
    private readonly client: pg.PoolClient,
    private readonly deadline: Deadline,
    private readonly lockWaitMs: number,
  ) {}

  async begin(): Promise<void> {
    this.assertTimeLeft();
    await this.client.query('BEGIN');
  }

  /** Runs one statement; a lock wait inside it ends at the lock wait limit or the deadline, whichever is sooner. */
  async query<Row extends pg.QueryResultRow>(sql: string, params?: unknown[]): Promise<pg.QueryResult<Row>> {
    const remaining = this.assertTimeLeft();
    // Local to the transaction (`true`), so the next statement is armed again, not left on the last value.
    await this.client.query(`SELECT set_config('statement_timeout', $1, true), set_config('lock_timeout', $2, true)`, [
      `${remaining}ms`,
      `${Math.min(this.lockWaitMs, remaining)}ms`,
    ]);
    return this.client.query<Row>(sql, params);
  }

  async commit(): Promise<void> {
    this.assertTimeLeft();
    await this.client.query('SET LOCAL statement_timeout = 0');
    await this.client.query('COMMIT');
  }

  /** Whether `error` is the deadline running out: the guard before a statement, or a cancel the armed timeouts raised. */
  deadlineRanOut(error: unknown): boolean {
    if (error instanceof DeadlineExceeded) return true;
    const code = (error as { code?: unknown } | null)?.code;
    return (code === STATEMENT_TIMEOUT || code === LOCK_NOT_AVAILABLE) && this.deadline.remainingMs() < 1;
  }

  private assertTimeLeft(): number {
    const remaining = this.deadline.remainingMs();
    if (remaining < 1) throw new DeadlineExceeded();
    return remaining;
  }
}
