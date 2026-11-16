import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import type { ExecuteDraftOutcome } from '../../../src/features/transfers/transfers-repository.js';
import { PgTransfersRepository } from '../../../src/features/transfers/pg-transfers-repository.js';
import { Deadline } from '../../../src/features/transfers/deadline.js';
import { grantMatchesDraft } from '../../../src/features/transfers/transfer-rules.js';

// Runs against the seeded compose Postgres (`make up && make seed`); skipped when it isn't reachable.
const url = process.env.TEST_DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 6 }) : undefined;
const reachable = pool
  ? await pool.query('SELECT 1 FROM bank.transfer_drafts LIMIT 1').then(
      () => true,
      () => false,
    )
  : false;

const LOCK_WAIT_MS = 300;
const BUDGET_MS = 7000;
const ACCOUNT = 'acc-juan-ars';
const GRANT = { amount: '10.00', currency: 'ARS', beneficiaryId: 'ben-juan-ana' };
const refused = (code: string) => ({ status: 'refused', code });

describe.skipIf(!reachable)('PgTransfersRepository (seeded Postgres)', () => {
  const db = pool as pg.Pool;
  const repo = new PgTransfersRepository(db, { lockWaitMs: LOCK_WAIT_MS });
  afterAll(() => pool?.end());

  const balance = async () =>
    (await db.query<{ balance: string }>(`SELECT balance::text FROM bank.accounts WHERE id = $1`, [ACCOUNT])).rows[0]
      ?.balance;

  /**
   * A pending draft with a unique booking time (so cleanup removes only this test's movements), run against the
   * seeded account, then removed and the balance restored.
   */
  async function withDraft(
    options: { amount?: string; fee?: string },
    run: (draftId: string, bookedAt: Date) => Promise<void>,
  ): Promise<void> {
    const draftId = `drf_${randomUUID()}`;
    const bookedAt = new Date(Date.UTC(2000, 0, 1, 0, 0, 0, Math.floor(Math.random() * 1e6)));
    const before = await balance();
    await db.query(
      `INSERT INTO bank.transfer_drafts (id, customer_id, source_account_id, beneficiary_id, amount, currency, fee, status, expires_at)
       VALUES ($1, 'juan', $2, 'ben-juan-ana', $3, 'ARS', $4, 'pending', now() + interval '5 minutes')`,
      [draftId, ACCOUNT, options.amount ?? '10.00', options.fee ?? '0'],
    );
    try {
      await run(draftId, bookedAt);
    } finally {
      await db.query(`UPDATE bank.accounts SET balance = $1 WHERE id = $2`, [before, ACCOUNT]);
      await db.query(`DELETE FROM bank.transactions WHERE account_id = $1 AND booked_at = $2`, [ACCOUNT, bookedAt]);
      await db.query(`DELETE FROM bank.transfers WHERE draft_id = $1`, [draftId]);
      await db.query(`DELETE FROM bank.used_jtis WHERE draft_id = $1`, [draftId]);
      await db.query(`DELETE FROM bank.transfer_drafts WHERE id = $1`, [draftId]);
    }
  }

  const jtiRows = async (draftId: string) =>
    (await db.query<{ jti: string }>(`SELECT jti FROM bank.used_jtis WHERE draft_id = $1`, [draftId])).rows;
  const transferRows = async (draftId: string) =>
    (await db.query<{ step_up_jti: string }>(`SELECT step_up_jti FROM bank.transfers WHERE draft_id = $1`, [draftId]))
      .rows;

  const execute = (
    draftId: string,
    jti: string,
    clock: () => Date,
    authorised = GRANT,
    { target = repo, budgetMs = BUDGET_MS } = {},
  ): Promise<ExecuteDraftOutcome> =>
    target.executeDraft(
      {
        draftId,
        jti,
        isAuthorised: (draft) => grantMatchesDraft(draft, authorised),
        deadline: Deadline.after(budgetMs),
      },
      clock,
    );

  const spendOnARejectedAttempt = (draftId: string, jti: string) =>
    db.query(`INSERT INTO bank.used_jtis (jti, draft_id) VALUES ($1, $2)`, [jti, draftId]);

  /** Resolves once a backend is blocked on a row lock of `table`, so the test commits the holder only after that. */
  async function untilWaitingOnLock(table: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { rowCount } = await db.query(
        `SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock' AND query ILIKE $1`,
        [`%bank.${table}%`],
      );
      if (rowCount) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`nothing waited on a lock of ${table}`);
  }

  /** Holds a row lock on `table` until released; the holder is a transaction of its own. */
  async function holdRowLock(table: 'transfer_drafts' | 'accounts', id: string) {
    const holder = await db.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM bank.${table} WHERE id = $1 FOR UPDATE`, [id]);
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        await holder.query('COMMIT').catch(() => undefined);
        holder.release();
      },
    };
  }

  it('executes once when two executions with one token race, answers both with the receipt and debits once', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const before = Number(await balance());
      const jti = `jti-${draftId}`;
      const [a, b] = await Promise.all([execute(draftId, jti, () => bookedAt), execute(draftId, jti, () => bookedAt)]);
      expect([a.status, b.status].sort()).toEqual(['already_executed', 'executed']);
      expect(a).toMatchObject({ receipt: (b as { receipt: unknown }).receipt });
      expect(before - Number(await balance())).toBeCloseTo(10, 2);
      expect(await transferRows(draftId)).toEqual([{ step_up_jti: jti }]);
    });
  });

  it('executes once when two executions with different tokens race, and spends only the executing token', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const before = Number(await balance());
      const [a, b] = await Promise.all([
        execute(draftId, `jti-a-${draftId}`, () => bookedAt),
        execute(draftId, `jti-b-${draftId}`, () => bookedAt),
      ]);
      expect([a.status, b.status].sort()).toEqual(['already_executed', 'executed']);
      expect(before - Number(await balance())).toBeCloseTo(10, 2);
      expect(await jtiRows(draftId)).toHaveLength(1);
    });
  });

  it('answers the token that executed the draft with the same receipt, and a token spent elsewhere draft_not_pending', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const executing = `jti-exec-${draftId}`;
      const stale = `jti-stale-${draftId}`;
      await spendOnARejectedAttempt(draftId, stale);
      const executed = await execute(draftId, executing, () => bookedAt);
      expect(executed.status).toBe('executed');
      // The replay carries exactly what the fresh execution returned: one column list for both.
      expect(await execute(draftId, executing, () => bookedAt)).toEqual({
        status: 'already_executed',
        receipt: (executed as { receipt: unknown }).receipt,
      });
      expect(await execute(draftId, stale, () => bookedAt)).toEqual(refused('draft_not_pending'));
      expect(await execute(draftId, `jti-fresh-${draftId}`, () => bookedAt)).toMatchObject({
        status: 'already_executed',
      });
      expect(await jtiRows(draftId)).toHaveLength(2);
    });
  });

  it('answers a spent token on a pending draft token_already_used, and moves nothing', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const before = await balance();
      const jti = `jti-${draftId}`;
      await spendOnARejectedAttempt(draftId, jti);
      expect(await execute(draftId, jti, () => bookedAt)).toEqual(refused('token_already_used'));
      expect(await transferRows(draftId)).toEqual([]);
      expect(await balance()).toBe(before);
    });
  });

  it('answers draft_expired, not token_already_used, for a spent token while the clock is still past expiry', async () => {
    await withDraft({}, async (draftId) => {
      const jti = `jti-${draftId}`;
      const later = new Date(Date.now() + 10 * 60_000);
      await spendOnARejectedAttempt(draftId, jti);
      expect(await execute(draftId, jti, () => later)).toEqual(refused('draft_expired'));
      expect(await execute(draftId, jti, () => later)).toEqual(refused('draft_expired'));
    });
  });

  it('spends no token on an expired draft', async () => {
    await withDraft({}, async (draftId) => {
      const later = new Date(Date.now() + 10 * 60_000);
      expect(await execute(draftId, `jti-${draftId}`, () => later)).toEqual(refused('draft_expired'));
      expect(await jtiRows(draftId)).toEqual([]);
    });
  });

  it('spends the token of an attempt the balance could not cover, and executes nothing', async () => {
    await withDraft({ amount: '999999999.00' }, async (draftId, bookedAt) => {
      const jti = `jti-${draftId}`;
      const grant = { ...GRANT, amount: '999999999.00' };
      const before = await balance();
      expect(await execute(draftId, jti, () => bookedAt, grant)).toEqual(refused('insufficient_funds'));
      expect(await execute(draftId, jti, () => bookedAt, grant)).toEqual(refused('token_already_used'));
      expect(await balance()).toBe(before);
    });
  });

  it('compares the grant with the draft read under the lock: a mismatch spends nothing, executed draft or not', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const tampered = { ...GRANT, amount: '1.00' };
      expect(await execute(draftId, `jti-bad-${draftId}`, () => bookedAt, tampered)).toEqual(refused('not_authorised'));
      expect(await jtiRows(draftId)).toEqual([]);
      expect((await execute(draftId, `jti-ok-${draftId}`, () => bookedAt)).status).toBe('executed');
      const elsewhere = { ...GRANT, beneficiaryId: 'ben-ana-lucia' };
      expect(await execute(draftId, `jti-new-${draftId}`, () => bookedAt, elsewhere)).toEqual(
        refused('not_authorised'),
      );
      expect(await jtiRows(draftId)).toHaveLength(1);
    });
  });

  it('fails closed as execution_in_progress when the draft stays locked, spending nothing', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const holder = await holdRowLock('transfer_drafts', draftId);
      try {
        const jti = `jti-${draftId}`;
        expect(await execute(draftId, jti, () => bookedAt)).toEqual(refused('execution_in_progress'));
        await holder.release();
        expect(await jtiRows(draftId)).toEqual([]);
        expect((await execute(draftId, jti, () => bookedAt)).status).toBe('executed');
      } finally {
        await holder.release();
      }
    });
  });

  it('waits for a draft lock that is released inside the wait limit, then executes', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const holder = await holdRowLock('transfer_drafts', draftId);
      try {
        const waiting = execute(draftId, `jti-${draftId}`, () => bookedAt);
        await untilWaitingOnLock('transfer_drafts');
        await holder.release();
        expect((await waiting).status).toBe('executed');
      } finally {
        await holder.release();
      }
    });
  });

  it('records the fee as its own movement, so the movements add up to the debit', async () => {
    await withDraft({ fee: '1.50' }, async (draftId, bookedAt) => {
      const before = Number(await balance());
      expect((await execute(draftId, `jti-${draftId}`, () => bookedAt)).status).toBe('executed');
      const { rows } = await db.query<{ amount: string; category: string }>(
        `SELECT amount::text, category FROM bank.transactions
          WHERE account_id = $1 AND booked_at = $2 ORDER BY category`,
        [ACCOUNT, bookedAt],
      );
      expect(rows).toEqual([
        { amount: '-1.50', category: 'comisiones' },
        { amount: '-10.00', category: 'transferencias' },
      ]);
      expect(before - Number(await balance())).toBeCloseTo(11.5, 2);
    });
  });

  it('refuses a draft that expired while the execution waited on its row lock', async () => {
    await withDraft({}, async (draftId) => {
      const before = await balance();
      const holder = await holdRowLock('transfer_drafts', draftId);
      try {
        let clock = new Date();
        const execution = execute(draftId, `jti-${draftId}`, () => clock);
        await untilWaitingOnLock('transfer_drafts');
        clock = new Date(Date.now() + 10 * 60_000); // The lock is released only after the draft's expiry.
        await holder.release();
        expect(await execution).toEqual(refused('draft_expired'));
        const { rows } = await db.query<{ status: string }>(`SELECT status FROM bank.transfer_drafts WHERE id = $1`, [
          draftId,
        ]);
        expect(rows[0]?.status).toBe('pending');
        expect(await transferRows(draftId)).toEqual([]);
        expect(await balance()).toBe(before);
      } finally {
        await holder.release();
      }
    });
  });

  it('rolls the token back when the account row stays locked, and answers account_busy', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const before = await balance();
      const jti = `jti-${draftId}`;
      const holder = await holdRowLock('accounts', ACCOUNT);
      try {
        expect(await execute(draftId, jti, () => bookedAt)).toEqual(refused('account_busy'));
        expect(await jtiRows(draftId)).toEqual([]); // The token row was written, then rolled back: still unspent.
        expect(await transferRows(draftId)).toEqual([]);
        await holder.release();
        expect(await balance()).toBe(before);
        expect((await execute(draftId, jti, () => bookedAt)).status).toBe('executed');
      } finally {
        await holder.release();
      }
    });
  });

  describe('total execution budget', () => {
    const SHORT_BUDGET_MS = 1500;
    const budgeted = { target: new PgTransfersRepository(db, { lockWaitMs: 1000 }), budgetMs: SHORT_BUDGET_MS };

    it('does not let a wait on the draft plus a wait on the account add up past the budget', async () => {
      await withDraft({}, async (draftId, bookedAt) => {
        const draftHolder = await holdRowLock('transfer_drafts', draftId);
        const accountHolder = await holdRowLock('accounts', ACCOUNT);
        try {
          const started = performance.now();
          const execution = execute(draftId, `jti-${draftId}`, () => bookedAt, GRANT, budgeted);
          await untilWaitingOnLock('transfer_drafts');
          await new Promise((resolve) => setTimeout(resolve, 800)); // Most of the draft wait: 1000 ms is allowed.
          await draftHolder.release();
          expect(await execution).toEqual(refused('account_busy'));
          // Unbudgeted, the account wait would run its own full 1000 ms after the 800 ms already spent.
          expect(performance.now() - started).toBeLessThan(SHORT_BUDGET_MS + 150);
          expect(await jtiRows(draftId)).toEqual([]);
        } finally {
          await draftHolder.release();
          await accountHolder.release();
        }
      });
    });

    it('caps a single wait at the budget when the lock wait limit is longer', async () => {
      const longWaits = { target: new PgTransfersRepository(db, { lockWaitMs: 10_000 }), budgetMs: 400 };
      await withDraft({}, async (draftId, bookedAt) => {
        const holder = await holdRowLock('transfer_drafts', draftId);
        try {
          const started = performance.now();
          expect(await execute(draftId, `jti-${draftId}`, () => bookedAt, GRANT, longWaits)).toEqual(
            refused('execution_in_progress'),
          );
          expect(performance.now() - started).toBeLessThan(1500);
        } finally {
          await holder.release();
        }
      });
    });
  });
});
