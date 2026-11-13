import pg from 'pg';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TRANSACTION_CATEGORIES } from '../../../src/features/accounts/categories.js';
import { PgAccountsRepository } from '../../../src/features/accounts/pg-accounts-repository.js';

// Runs against the seeded compose Postgres (`make up && make seed`); skipped when it isn't reachable.
const url = process.env.TEST_DATABASE_URL;
const pool = url ? new pg.Pool({ connectionString: url, max: 2 }) : undefined;
const reachable = pool
  ? await pool.query('SELECT 1 FROM bank.accounts LIMIT 1').then(
      () => true,
      () => false,
    )
  : false;

describe.skipIf(!reachable)('PgAccountsRepository (seeded Postgres)', () => {
  const repo = new PgAccountsRepository(pool as pg.Pool, 'America/Argentina/Buenos_Aires');
  afterAll(() => pool?.end());

  it("lists only the customer's own accounts", async () => {
    const accounts = await repo.listAccounts('ana');
    expect(accounts.map((a) => a.id).sort()).toEqual(['acc-ana-ars', 'acc-ana-usd']);
  });

  it("returns nothing when one customer filters by another's account id", async () => {
    expect(await repo.listTransactions({ customerId: 'ana', accountId: 'acc-juan-ars', limit: 10 })).toEqual([]);
    expect(
      await repo.spendingByCategory({
        customerId: 'ana',
        accountId: 'acc-juan-ars',
        from: '2000-01-01',
        to: '2100-01-01',
      }),
    ).toEqual([]);
  });

  it('totals last month by category as positive amounts', async () => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
    const to = new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
    const spend = await repo.spendingByCategory({ customerId: 'ana', from, to });
    expect(spend.length).toBeGreaterThan(3);
    for (const row of spend) expect(Number(row.total)).toBeGreaterThan(0);
  });

  it('knows every category the seed books, and only those', async () => {
    const { rows } = await (pool as pg.Pool).query<{ category: string }>(
      'SELECT DISTINCT category FROM bank.transactions ORDER BY category',
    );
    expect(rows.map((r) => r.category)).toEqual([...TRANSACTION_CATEGORIES]);
  });

  it('matches a category whatever its case', async () => {
    const mixed = await repo.listTransactions({ customerId: 'ana', category: 'SuperMercado', limit: 5 });
    expect(mixed.length).toBeGreaterThan(0);
    for (const t of mixed) expect(t.category).toBe('supermercado');
  });

  describe('a debit at 22:30 on 31 Oct in Buenos Aires (01:30 on 1 Nov in UTC)', () => {
    const CATEGORY = 'test-tz-boundary';
    let id: string;

    beforeEach(async () => {
      const {
        rows: [row],
      } = await (pool as pg.Pool).query<{ id: string }>(
        `INSERT INTO bank.transactions (account_id, booked_at, amount, category, merchant)
         VALUES ('acc-ana-usd', '2026-10-31 22:30:00-03', -12.34, $1, 'Prueba') RETURNING id::text`,
        [CATEGORY],
      );
      if (!row) throw new Error('insert returned no row');
      id = row.id;
    });
    afterEach(() => (pool as pg.Pool).query('DELETE FROM bank.transactions WHERE id = $1', [id]));

    const list = (from: string, to: string) =>
      repo.listTransactions({ customerId: 'ana', accountId: 'acc-ana-usd', from, to, limit: 100 });
    const spend = (from: string, to: string) =>
      repo.spendingByCategory({ customerId: 'ana', accountId: 'acc-ana-usd', from, to });

    it('lists it in October, not November, with the bank offset', async () => {
      expect((await list('2026-10-31', '2026-10-31')).find((t) => t.id === id)?.bookedAt).toBe(
        '2026-10-31T22:30:00.000-03:00',
      );
      expect((await list('2026-11-01', '2026-11-30')).map((t) => t.id)).not.toContain(id);
    });

    it('totals it in October, not November', async () => {
      expect((await spend('2026-10-01', '2026-10-31')).find((c) => c.category === CATEGORY)?.total).toBe('12.34');
      expect((await spend('2026-11-01', '2026-11-30')).map((c) => c.category)).not.toContain(CATEGORY);
    });
  });
});
