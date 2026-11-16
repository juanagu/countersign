import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { Deadline } from '../../../src/features/transfers/deadline.js';
import { PgTransfersRepository } from '../../../src/features/transfers/pg-transfers-repository.js';
import type { ExecuteDraftRequest } from '../../../src/features/transfers/transfers-repository.js';

// The transaction's own plumbing against a scripted connection: what it sends, and what it does with the client.
// The locking behaviour itself runs against Postgres in pg-transfers-repository.pg.test.ts.

const DRAFT_ROW = {
  id: 'drf_1',
  customerId: 'juan',
  sourceAccountId: 'acc-juan-ars',
  beneficiaryId: 'ben-juan-ana',
  amount: '10.00',
  fee: '0.00',
  currency: 'ARS',
  status: 'pending',
  expiresAt: '2026-11-13T12:05:00.000Z',
};
const NOW = new Date('2026-11-13T12:00:00.000Z');
const RECEIPT_ROW = { transferId: 'trf_1', draftId: 'drf_1', reference: 'BD-1', executedAt: NOW.toISOString() };

type Script = (sql: string) => unknown;

function scriptedPool(script: Script) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql.trim());
      return script(sql);
    }),
    release: vi.fn(),
  };
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return { pool, client, queries };
}

/** A connection that answers every statement of a successful execution, then whatever `override` says. */
const happyPath =
  (override: Script = () => undefined): Script =>
  (sql) => {
    const overridden = override(sql);
    if (overridden !== undefined) return overridden;
    if (sql.includes('FOR UPDATE')) return { rows: [DRAFT_ROW], rowCount: 1 };
    if (sql.includes('INSERT INTO bank.transfers')) return { rows: [RECEIPT_ROW], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };

const request = (deadline: Deadline, isAuthorised = () => true): ExecuteDraftRequest => ({
  draftId: 'drf_1',
  jti: 'jti-1',
  isAuthorised,
  deadline,
});
const statementTimeouts = (queries: string[]) => queries.filter((sql) => sql.includes('statement_timeout'));
const driverError = (code: string) => Object.assign(new Error('driver text'), { code });

describe('PgTransfersRepository.executeDraft transaction', () => {
  it('commits with no statement timeout armed, and sets the waits only before the two lock waits', async () => {
    const { pool, queries } = scriptedPool(happyPath());
    const outcome = await new PgTransfersRepository(pool).executeDraft(request(Deadline.after(5000)), () => NOW);

    expect(outcome.status).toBe('executed');
    const commit = queries.indexOf('COMMIT');
    expect(queries[commit - 1]).toBe('SET LOCAL statement_timeout = 0');
    expect(statementTimeouts(queries)).toHaveLength(3); // The draft wait, the account wait, the disarm.
  });

  it('refuses without starting a transaction when the budget is spent before it begins', async () => {
    const { pool, queries } = scriptedPool(happyPath());
    const outcome = await new PgTransfersRepository(pool).executeDraft(request(Deadline.after(0)), () => NOW);

    expect(outcome).toEqual({ status: 'refused', code: 'execution_in_progress' });
    expect(queries).toEqual([]);
  });

  it('rolls back with a definite refusal, not a raw cancel, when the budget runs out before the account wait', async () => {
    let elapsedMs = 0;
    const { pool, queries, client } = scriptedPool(happyPath());
    const outcome = await new PgTransfersRepository(pool).executeDraft(
      request(Deadline.after(1000, () => elapsedMs)),
      () => {
        elapsedMs = 5000; // The clock is read after the draft's lock: the wait for it used the budget up.
        return NOW;
      },
    );

    expect(outcome).toEqual({ status: 'refused', code: 'account_busy' });
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(queries.some((sql) => sql.startsWith('UPDATE bank.accounts'))).toBe(false);
    expect(client.release).toHaveBeenCalledWith(undefined); // The connection is healthy.
  });

  it('calls the grant check the use case passed with the draft row it locked', async () => {
    const { pool, queries } = scriptedPool(happyPath());
    const isAuthorised = vi.fn(() => false);
    const outcome = await new PgTransfersRepository(pool).executeDraft(
      request(Deadline.after(5000), isAuthorised),
      () => NOW,
    );

    expect(isAuthorised).toHaveBeenCalledWith(DRAFT_ROW);
    expect(outcome).toEqual({ status: 'refused', code: 'not_authorised' });
    expect(queries.some((sql) => sql.includes('used_jtis'))).toBe(false);
  });

  it('answers a replay with one query for the receipt and both token facts', async () => {
    const executed = { ...DRAFT_ROW, status: 'executed' };
    const replayRow = { ...RECEIPT_ROW, executedByThisToken: true, tokenSpent: true };
    const { pool, queries } = scriptedPool(
      happyPath((sql) => {
        if (sql.includes('FOR UPDATE')) return { rows: [executed] };
        if (sql.includes('FROM bank.transfers')) return { rows: [replayRow] };
        return undefined;
      }),
    );
    const outcome = await new PgTransfersRepository(pool).executeDraft(request(Deadline.after(5000)), () => NOW);

    expect(outcome).toEqual({ status: 'already_executed', receipt: RECEIPT_ROW });
    expect(queries.filter((sql) => sql.includes('FROM bank.transfers'))).toHaveLength(1);
  });

  it('releases the connection with the error when a statement fails, so the pool drops it', async () => {
    const failure = driverError('08006');
    const { pool, client } = scriptedPool(
      happyPath((sql) => {
        if (sql.includes('FOR UPDATE')) throw failure;
        return undefined;
      }),
    );
    await expect(new PgTransfersRepository(pool).executeDraft(request(Deadline.after(5000)), () => NOW)).rejects.toBe(
      failure,
    );
    expect(client.release).toHaveBeenCalledWith(failure);
  });

  it('releases the connection with the error when the rollback fails too', async () => {
    const broken = driverError('57P01');
    const { pool, client } = scriptedPool(
      happyPath((sql) => {
        if (sql.includes('FOR UPDATE')) throw driverError('55P03');
        if (sql === 'ROLLBACK') throw broken;
        return undefined;
      }),
    );
    const outcome = await new PgTransfersRepository(pool).executeDraft(request(Deadline.after(5000)), () => NOW);
    expect(outcome).toEqual({ status: 'refused', code: 'execution_in_progress' });
    expect(client.release).toHaveBeenCalledWith(broken);
  });

  describe('cancellations', () => {
    const failingOn = (code: string) =>
      scriptedPool(
        happyPath((sql) => {
          if (sql.includes('FOR UPDATE')) throw driverError(code);
          return undefined;
        }),
      );

    it('reads a lock timeout (55P03) as a lock-wait refusal and keeps the connection', async () => {
      const { pool, client } = failingOn('55P03');
      const outcome = await new PgTransfersRepository(pool).executeDraft(request(Deadline.after(5000)), () => NOW);
      expect(outcome).toEqual({ status: 'refused', code: 'execution_in_progress' });
      expect(client.release).toHaveBeenCalledWith(undefined);
    });

    it('does not read a statement cancellation (57014) as a lock-wait refusal: its outcome is an error', async () => {
      const { pool } = failingOn('57014');
      await expect(
        new PgTransfersRepository(pool).executeDraft(request(Deadline.after(5000)), () => NOW),
      ).rejects.toMatchObject({ code: '57014' });
    });

    it('arms the statement timeout above the lock timeout, so a lock wait ends by lock_timeout first', async () => {
      const calls: unknown[][] = [];
      const { pool, client } = scriptedPool(happyPath());
      client.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('set_config')) calls.push(params ?? []);
        return happyPath()(sql);
      });
      await new PgTransfersRepository(pool, { lockWaitMs: 5000 }).executeDraft(
        request(Deadline.after(1000)),
        () => NOW,
      );
      const [lock, statement] = calls[0] as [string, string];
      expect(parseInt(statement)).toBeGreaterThan(parseInt(lock));
    });
  });
});
