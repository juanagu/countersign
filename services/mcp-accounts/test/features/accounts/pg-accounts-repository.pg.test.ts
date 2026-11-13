import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
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
  const repo = new PgAccountsRepository(pool as pg.Pool);
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
});
