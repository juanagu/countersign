import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PgTransfersRepository } from '../../../src/features/transfers/pg-transfers-repository.js';

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
const ACCOUNT = 'acc-juan-ars';

describe.skipIf(!reachable)('PgTransfersRepository (seeded Postgres)', () => {
  const db = pool as pg.Pool;
  const repo = new PgTransfersRepository(db, LOCK_WAIT_MS);
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

  it('executes once when two executions with one token race, answers both with the receipt and debits once', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const before = Number(await balance());
      const jti = `jti-${draftId}`;
      const [a, b] = await Promise.all([
        repo.executeDraft(draftId, jti, () => bookedAt),
        repo.executeDraft(draftId, jti, () => bookedAt),
      ]);
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
        repo.executeDraft(draftId, `jti-a-${draftId}`, () => bookedAt),
        repo.executeDraft(draftId, `jti-b-${draftId}`, () => bookedAt),
      ]);
      expect([a.status, b.status].sort()).toEqual(['already_executed', 'executed']);
      expect(before - Number(await balance())).toBeCloseTo(10, 2);
      expect(await jtiRows(draftId)).toHaveLength(1);
    });
  });

  it('answers the token that executed the draft with the same receipt, and a token spent elsewhere not_pending', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const executing = `jti-exec-${draftId}`;
      const stale = `jti-stale-${draftId}`;
      const later = new Date(Date.now() + 10 * 60_000);
      expect((await repo.executeDraft(draftId, stale, () => later)).status).toBe('expired');
      const executed = await repo.executeDraft(draftId, executing, () => bookedAt);
      expect(executed.status).toBe('executed');
      expect(await repo.executeDraft(draftId, executing, () => bookedAt)).toEqual({
        status: 'already_executed',
        receipt: (executed as { receipt: unknown }).receipt,
      });
      expect(await repo.executeDraft(draftId, stale, () => bookedAt)).toEqual({ status: 'not_pending' });
      const fresh = await repo.executeDraft(draftId, `jti-fresh-${draftId}`, () => bookedAt);
      expect(fresh).toMatchObject({ status: 'already_executed' });
      expect(await jtiRows(draftId)).toHaveLength(2);
    });
  });

  it('keeps a token a rejected attempt spent as token_already_used while the draft is pending, and moves nothing', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const before = await balance();
      const jti = `jti-${draftId}`;
      const later = new Date(Date.now() + 10 * 60_000);
      expect((await repo.executeDraft(draftId, jti, () => later)).status).toBe('expired');
      expect((await jtiRows(draftId)).map((r) => r.jti)).toEqual([jti]);
      expect(await repo.executeDraft(draftId, jti, () => bookedAt)).toEqual({ status: 'token_already_used' });
      expect(await transferRows(draftId)).toEqual([]);
      expect(await balance()).toBe(before);
    });
  });

  it('spends the token of an attempt the balance could not cover, and executes nothing', async () => {
    await withDraft({ amount: '999999999.00' }, async (draftId, bookedAt) => {
      const jti = `jti-${draftId}`;
      const before = await balance();
      expect((await repo.executeDraft(draftId, jti, () => bookedAt)).status).toBe('insufficient_funds');
      expect(await repo.executeDraft(draftId, jti, () => bookedAt)).toEqual({ status: 'token_already_used' });
      expect(await balance()).toBe(before);
    });
  });

  it('fails closed as in_progress when the draft stays locked, spending nothing', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const holder = await db.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM bank.transfer_drafts WHERE id = $1 FOR UPDATE`, [draftId]);
        const jti = `jti-${draftId}`;
        expect(await repo.executeDraft(draftId, jti, () => bookedAt)).toEqual({ status: 'in_progress' });
        await holder.query('COMMIT');
        expect(await jtiRows(draftId)).toEqual([]);
        expect((await repo.executeDraft(draftId, jti, () => bookedAt)).status).toBe('executed');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });
  });

  it('waits for a lock that is released inside the wait limit and then answers from the record', async () => {
    await withDraft({}, async (draftId, bookedAt) => {
      const jti = `jti-${draftId}`;
      const holder = await db.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM bank.transfer_drafts WHERE id = $1 FOR UPDATE`, [draftId]);
        const waiting = repo.executeDraft(draftId, jti, () => bookedAt);
        await holder.query('COMMIT');
        expect((await waiting).status).toBe('executed');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });
  });

  it('records the fee as its own movement, so the movements add up to the debit', async () => {
    await withDraft({ fee: '1.50' }, async (draftId, bookedAt) => {
      const before = Number(await balance());
      expect((await repo.executeDraft(draftId, `jti-${draftId}`, () => bookedAt)).status).toBe('executed');
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
      const holder = await db.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(`SELECT 1 FROM bank.transfer_drafts WHERE id = $1 FOR UPDATE`, [draftId]);
        let clock = new Date();
        const execution = repo.executeDraft(draftId, `jti-${draftId}`, () => clock);
        clock = new Date(Date.now() + 10 * 60_000); // The lock is released only after the draft's expiry.
        await holder.query('COMMIT');
        expect((await execution).status).toBe('expired');
        const { rows } = await db.query<{ status: string }>(`SELECT status FROM bank.transfer_drafts WHERE id = $1`, [
          draftId,
        ]);
        expect(rows[0]?.status).toBe('pending');
        expect(await transferRows(draftId)).toEqual([]);
        expect(await balance()).toBe(before);
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });
  });
});
