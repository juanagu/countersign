import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PgTransfersRepository } from '../../../src/features/transfers/pg-transfers-repository.js';

// Runs against the seeded compose Postgres (`make up && make seed`); skipped when it isn't reachable.
const url = process.env.TEST_DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 4 }) : undefined;
const reachable = pool
  ? await pool.query('SELECT 1 FROM bank.transfer_drafts LIMIT 1').then(
      () => true,
      () => false,
    )
  : false;

describe.skipIf(!reachable)('PgTransfersRepository (seeded Postgres)', () => {
  const repo = new PgTransfersRepository(pool as pg.Pool);
  const db = pool as pg.Pool;
  afterAll(() => pool?.end());

  it('executes a draft once when two executions race, and debits once', async () => {
    const draftId = `drf_${randomUUID()}`;
    const before = await db.query<{ balance: string }>(
      `SELECT balance::text FROM bank.accounts WHERE id = 'acc-juan-ars'`,
    );
    await db.query(
      `INSERT INTO bank.transfer_drafts (id, customer_id, source_account_id, beneficiary_id, amount, currency, fee, status, expires_at)
       VALUES ($1, 'juan', 'acc-juan-ars', 'ben-juan-ana', 10.00, 'ARS', 0, 'pending', now() + interval '5 minutes')`,
      [draftId],
    );
    try {
      const [a, b] = await Promise.all([
        repo.executeDraft(draftId, new Date()),
        repo.executeDraft(draftId, new Date()),
      ]);
      expect([a.status, b.status].sort()).toEqual(['already_executed', 'executed']);
      const after = await db.query<{ balance: string }>(
        `SELECT balance::text FROM bank.accounts WHERE id = 'acc-juan-ars'`,
      );
      expect(Number(before.rows[0]?.balance) - Number(after.rows[0]?.balance)).toBeCloseTo(10, 2);
      expect(await repo.claimTokenId(`jti-${draftId}`)).toBe(true);
      expect(await repo.claimTokenId(`jti-${draftId}`)).toBe(false);
    } finally {
      await db.query(`UPDATE bank.accounts SET balance = $1 WHERE id = 'acc-juan-ars'`, [before.rows[0]?.balance]);
      await db.query(
        `DELETE FROM bank.transactions WHERE account_id = 'acc-juan-ars' AND memo = 'Transferencia enviada' AND amount = -10.00`,
      );
      await db.query(`DELETE FROM bank.transfers WHERE draft_id = $1`, [draftId]);
      await db.query(`DELETE FROM bank.transfer_drafts WHERE id = $1`, [draftId]);
      await db.query(`DELETE FROM bank.used_jtis WHERE jti = $1`, [`jti-${draftId}`]);
    }
  });

  it('records the fee as its own movement, so the movements add up to the debit', async () => {
    const draftId = `drf_${randomUUID()}`;
    const balance = async () =>
      Number(
        (await db.query<{ balance: string }>(`SELECT balance::text FROM bank.accounts WHERE id = 'acc-juan-ars'`))
          .rows[0]?.balance,
      );
    const before = await balance();
    // A booking time no seeded row has, so the cleanup deletes only this test's movements.
    const bookedAt = new Date('2000-01-01T00:00:00.000Z');
    await db.query(
      `INSERT INTO bank.transfer_drafts (id, customer_id, source_account_id, beneficiary_id, amount, currency, fee, status, expires_at)
       VALUES ($1, 'juan', 'acc-juan-ars', 'ben-juan-ana', 10.00, 'ARS', 1.50, 'pending', now() + interval '5 minutes')`,
      [draftId],
    );
    try {
      expect((await repo.executeDraft(draftId, bookedAt)).status).toBe('executed');
      const { rows } = await db.query<{ amount: string; category: string }>(
        `SELECT amount::text, category FROM bank.transactions
          WHERE account_id = 'acc-juan-ars' AND booked_at = $1 ORDER BY category`,
        [bookedAt],
      );
      expect(rows).toEqual([
        { amount: '-1.50', category: 'comisiones' },
        { amount: '-10.00', category: 'transferencias' },
      ]);
      expect(before - (await balance())).toBeCloseTo(11.5, 2);
    } finally {
      await db.query(`UPDATE bank.accounts SET balance = $1 WHERE id = 'acc-juan-ars'`, [before.toFixed(2)]);
      await db.query(`DELETE FROM bank.transactions WHERE account_id = 'acc-juan-ars' AND booked_at = $1`, [bookedAt]);
      await db.query(`DELETE FROM bank.transfers WHERE draft_id = $1`, [draftId]);
      await db.query(`DELETE FROM bank.transfer_drafts WHERE id = $1`, [draftId]);
    }
  });
});
