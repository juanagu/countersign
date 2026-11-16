import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { Deadline } from '../../../src/features/transfers/deadline.js';
import { PgTransfersRepository } from '../../../src/features/transfers/pg-transfers-repository.js';
import type { ExecuteDraftRequest } from '../../../src/features/transfers/transfers-repository.js';

// The transaction's own plumbing against a scripted connection: what it sends, and what it does with the client.
// The locking behaviour itself runs against Postgres in pg-transfers-repository.pg.test.ts.

const DRAFT = {
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
const LOCKED_ROW = {
  ...DRAFT,
  accountAlias: 'Pesos',
  accountNumber: '0170-0002-7810',
  beneficiaryName: 'Ana Gómez',
  beneficiaryBank: 'Banco Demo',
  beneficiaryAccountRef: '0170000100000000045211',
};
const NOW = new Date('2026-11-13T12:00:00.000Z');
const TRANSFER_ROW = { transferId: 'trf_1', reference: 'BD-1', executedAt: NOW.toISOString() };
const RECEIPT = {
  ...TRANSFER_ROW,
  draftId: 'drf_1',
  amount: '10.00',
  fee: '0.00',
  currency: 'ARS',
  sourceAccount: { id: 'acc-juan-ars', alias: 'Pesos', number: '0170-0002-7810' },
  beneficiary: {
    id: 'ben-juan-ana',
    fullName: 'Ana Gómez',
    bankName: 'Banco Demo',
    accountRef: '0170000100000000045211',
  },
};

type Script = (sql: string) => unknown;

function scriptedPool(script: Script, { statementMs = 0 } = {}) {
  const queries: string[] = [];
  const armed: { statement: number; lock: number }[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: string[]) => {
      queries.push(sql.trim());
      if (sql.includes('set_config'))
        armed.push({ statement: parseInt(params?.[0] ?? ''), lock: parseInt(params?.[1] ?? '') });
      else if (statementMs) await new Promise((resolve) => setTimeout(resolve, statementMs));
      return script(sql);
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as pg.Pool & { connect: ReturnType<typeof vi.fn> };
  return { pool, client, queries, armed };
}

/** A connection that answers every statement of a successful execution, then whatever `override` says. */
const happyPath =
  (override: Script = () => undefined): Script =>
  (sql) => {
    const overridden = override(sql);
    if (overridden !== undefined) return overridden;
    if (sql.includes('FOR UPDATE')) return { rows: [LOCKED_ROW], rowCount: 1 };
    if (sql.includes('INSERT INTO bank.transfers')) return { rows: [TRANSFER_ROW], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };

const request = (deadline: Deadline, isAuthorised = () => true): ExecuteDraftRequest => ({
  draftId: 'drf_1',
  customerId: 'juan',
  jti: 'jti-1',
  isAuthorised,
  deadline,
});
const driverError = (code: string) => Object.assign(new Error('driver text'), { code });
const executeWith = (pool: pg.Pool, deadline: Deadline, options = {}) =>
  new PgTransfersRepository(pool, options).executeDraft(request(deadline), () => NOW);
const notExecuted = { status: 'refused', code: 'not_executed' };

describe('PgTransfersRepository.executeDraft transaction', () => {
  it('arms every statement of the transaction from what is left, and the commit with no statement timeout', async () => {
    const { pool, queries } = scriptedPool(happyPath());
    const outcome = await executeWith(pool, Deadline.after(5000));

    expect(outcome).toEqual({ status: 'executed', receipt: RECEIPT });
    const commit = queries.indexOf('COMMIT');
    expect(queries[commit - 1]).toBe('SET LOCAL statement_timeout = 0');
    const statements = queries.slice(queries.indexOf('BEGIN') + 1, commit - 1);
    expect(statements.length).toBeGreaterThan(6);
    statements.forEach((sql, position) => {
      if (position % 2 === 0) expect(sql).toContain('set_config');
      else expect(sql).not.toContain('set_config');
    });
  });

  it('does not connect when the budget is already spent, and answers not_executed', async () => {
    const { pool } = scriptedPool(happyPath());
    expect(await executeWith(pool, Deadline.after(0))).toEqual(notExecuted);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it('answers not_executed when no connection comes before the budget is spent, and returns a late one', async () => {
    const { pool, client } = scriptedPool(happyPath());
    let arrive: (value: unknown) => void = () => undefined;
    pool.connect.mockReturnValue(new Promise((resolve) => (arrive = resolve)));
    const started = performance.now();

    expect(await executeWith(pool, Deadline.after(50))).toEqual(notExecuted);
    expect(performance.now() - started).toBeLessThan(250);
    expect(client.query).not.toHaveBeenCalled();
    arrive(client);
    await new Promise((resolve) => setImmediate(resolve));
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('answers not_executed when the pool gives up on a connection', async () => {
    const { pool } = scriptedPool(happyPath());
    pool.connect.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    expect(await executeWith(pool, Deadline.after(5000))).toEqual(notExecuted);
  });

  it('cannot be kept past its budget by several slow statements: it stops before the one with nothing left', async () => {
    const budgetMs = 100;
    const { pool, queries, armed, client } = scriptedPool(happyPath(), { statementMs: 40 });
    const started = performance.now();
    const outcome = await executeWith(pool, Deadline.after(budgetMs));
    const elapsedMs = performance.now() - started;

    expect(outcome).toEqual(notExecuted);
    // Every statement ran its 40 ms but none was started with nothing left; the unbounded run is eight of them.
    expect(elapsedMs).toBeLessThan(budgetMs + 40 + 60);
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
    expect(armed.every(({ statement }) => statement <= budgetMs)).toBe(true);
    expect(armed.map(({ statement }) => statement)).toEqual(
      [...armed.map(({ statement }) => statement)].sort((a, b) => b - a),
    );
    expect(client.release).toHaveBeenCalledWith(undefined);
  });

  it('rolls back, never commits, when the budget runs out between the last statement and the commit', async () => {
    let elapsedMs = 0;
    const { pool, queries } = scriptedPool(
      happyPath((sql) => {
        if (sql.includes('INSERT INTO bank.transfers')) {
          elapsedMs = 5000;
          return { rows: [TRANSFER_ROW], rowCount: 1 };
        }
        return undefined;
      }),
    );

    expect(
      await executeWith(
        pool,
        Deadline.after(1000, () => elapsedMs),
      ),
    ).toEqual(notExecuted);
    expect(queries).toContain('ROLLBACK');
    expect(queries).not.toContain('COMMIT');
  });

  it('rolls back with not_executed, before the account is touched, when the budget is gone by the account step', async () => {
    let elapsedMs = 0;
    const { pool, queries, client } = scriptedPool(happyPath());
    const outcome = await new PgTransfersRepository(pool).executeDraft(
      request(Deadline.after(1000, () => elapsedMs)),
      () => {
        elapsedMs = 5000; // The clock is read after the draft's lock: the wait for it used the budget up.
        return NOW;
      },
    );

    expect(outcome).toEqual(notExecuted);
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

    expect(isAuthorised).toHaveBeenCalledWith(DRAFT);
    expect(outcome).toEqual({ status: 'refused', code: 'not_authorised' });
    expect(queries.some((sql) => sql.includes('used_jtis'))).toBe(false);
  });

  it.each([
    ['is missing', []],
    ['is another customer’s', [{ ...LOCKED_ROW, customerId: 'ana' }]],
  ])('answers draft_not_found, spending nothing, when the draft the lock returns %s', async (_, rows) => {
    const { pool, queries } = scriptedPool(happyPath((sql) => (sql.includes('FOR UPDATE') ? { rows } : undefined)));
    const isAuthorised = vi.fn(() => true);
    const outcome = await new PgTransfersRepository(pool).executeDraft(
      request(Deadline.after(5000), isAuthorised),
      () => NOW,
    );

    expect(outcome).toEqual({ status: 'refused', code: 'draft_not_found' });
    expect(isAuthorised).not.toHaveBeenCalled();
    expect(queries.some((sql) => sql.includes('used_jtis'))).toBe(false);
  });

  it('answers a replay from the locked row and one query for the transfer and both token facts', async () => {
    const replayRow = { ...TRANSFER_ROW, executedByThisToken: true, tokenSpent: true };
    const { pool, queries } = scriptedPool(
      happyPath((sql) => {
        if (sql.includes('FOR UPDATE')) return { rows: [{ ...LOCKED_ROW, status: 'executed' }] };
        if (sql.includes('FROM bank.transfers')) return { rows: [replayRow] };
        return undefined;
      }),
    );
    const outcome = await executeWith(pool, Deadline.after(5000));

    expect(outcome).toEqual({ status: 'already_executed', receipt: RECEIPT });
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
    await expect(executeWith(pool, Deadline.after(5000))).rejects.toBe(failure);
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
    expect(await executeWith(pool, Deadline.after(5000))).toEqual({ status: 'refused', code: 'execution_in_progress' });
    expect(client.release).toHaveBeenCalledWith(broken);
  });

  it('lets a failed commit through as an error, whose outcome is unknown', async () => {
    const failure = driverError('08006');
    const { pool } = scriptedPool(
      happyPath((sql) => {
        if (sql === 'COMMIT') throw failure;
        return undefined;
      }),
    );
    await expect(executeWith(pool, Deadline.after(5000))).rejects.toBe(failure);
  });

  describe('cancellations', () => {
    const failingOn = (code: string, deadline = Deadline.after(5000), beforeThrow: () => void = () => undefined) => {
      const scripted = scriptedPool(
        happyPath((sql) => {
          if (!sql.includes('FOR UPDATE')) return undefined;
          beforeThrow();
          throw driverError(code);
        }),
      );
      return { ...scripted, outcome: () => executeWith(scripted.pool, deadline) };
    };

    it('reads a lock timeout (55P03) with time left as another call holding the row, and keeps the connection', async () => {
      const { client, outcome } = failingOn('55P03');
      expect(await outcome()).toEqual({ status: 'refused', code: 'execution_in_progress' });
      expect(client.release).toHaveBeenCalledWith(undefined);
    });

    it('does not read a statement cancellation (57014) with time left as a lock wait: its outcome is an error', async () => {
      const { outcome } = failingOn('57014');
      await expect(outcome()).rejects.toMatchObject({ code: '57014' });
    });

    it.each(['55P03', '57014'])(
      'reads %s as the deadline running out when nothing is left: not_executed',
      async (code) => {
        let elapsedMs = 0;
        // The wait ended at the budget: both timeouts were armed to it.
        const { outcome } = failingOn(
          code,
          Deadline.after(1000, () => elapsedMs),
          () => (elapsedMs = 1000),
        );
        expect(await outcome()).toEqual(notExecuted);
      },
    );

    it('arms the lock timeout at the lock wait limit, or at what is left when that is less, never past the statement', async () => {
      const { pool, armed } = scriptedPool(happyPath());
      await executeWith(pool, Deadline.after(5000), { lockWaitMs: 200 });
      expect(armed[0]?.lock).toBe(200);

      const short = scriptedPool(happyPath());
      await executeWith(short.pool, Deadline.after(1000), { lockWaitMs: 5000 });
      expect(short.armed[0]?.lock).toBeLessThanOrEqual(1000);
      expect(short.armed.every(({ lock, statement }) => lock <= statement)).toBe(true);
    });
  });
});
