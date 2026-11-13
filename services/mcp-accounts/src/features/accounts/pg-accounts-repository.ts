import type pg from 'pg';
import type {
  Account,
  AccountsRepository,
  CategorySpend,
  SpendingQuery,
  Transaction,
  TransactionQuery,
} from './accounts-repository.js';
import { toBankIso } from './bank-time.js';

const ACCOUNT_COLUMNS = `id, customer_id AS "customerId", kind, currency, alias, number, balance::text AS balance`;

/**
 * `from` and `to` are whole bank-local days, both inclusive. The zone is a query parameter rather than the
 * pool's session `TimeZone` so the bounds stay right on any pool handed in, including a test's.
 */
export class PgAccountsRepository implements AccountsRepository {
  constructor(
    private readonly pool: pg.Pool,
    private readonly timeZone: string,
  ) {}

  async listAccounts(customerId: string): Promise<Account[]> {
    const { rows } = await this.pool.query<Account>(
      `SELECT ${ACCOUNT_COLUMNS} FROM bank.accounts WHERE customer_id = $1 ORDER BY currency, id`,
      [customerId],
    );
    return rows;
  }

  async findAccount(accountId: string): Promise<Account | undefined> {
    const { rows } = await this.pool.query<Account>(`SELECT ${ACCOUNT_COLUMNS} FROM bank.accounts WHERE id = $1`, [
      accountId,
    ]);
    return rows[0];
  }

  async listTransactions(q: TransactionQuery): Promise<Transaction[]> {
    const { rows } = await this.pool.query<Transaction>(
      `SELECT t.id::text AS id, t.account_id AS "accountId", t.booked_at AS "bookedAt", t.amount::text AS amount,
              a.currency, t.category, t.merchant, t.memo
         FROM bank.transactions t JOIN bank.accounts a ON a.id = t.account_id
        WHERE a.customer_id = $1
          AND ($2::text IS NULL OR t.account_id = $2)
          AND ($3::date IS NULL OR t.booked_at >= ($3::date::timestamp AT TIME ZONE $7::text))
          AND ($4::date IS NULL OR t.booked_at < (($4::date + 1)::timestamp AT TIME ZONE $7::text))
          AND ($5::text IS NULL OR lower(t.category) = lower($5))
        ORDER BY t.booked_at DESC
        LIMIT $6`,
      [q.customerId, q.accountId ?? null, q.from ?? null, q.to ?? null, q.category ?? null, q.limit, this.timeZone],
    );
    return rows.map((row) => ({ ...row, bookedAt: toBankIso(new Date(row.bookedAt), this.timeZone) }));
  }

  async spendingByCategory(q: SpendingQuery): Promise<CategorySpend[]> {
    const { rows } = await this.pool.query<CategorySpend>(
      `SELECT t.category, a.currency, (-sum(t.amount))::text AS total, count(*)::int AS count
         FROM bank.transactions t JOIN bank.accounts a ON a.id = t.account_id
        WHERE a.customer_id = $1
          AND ($2::text IS NULL OR t.account_id = $2)
          AND t.booked_at >= ($3::date::timestamp AT TIME ZONE $5::text)
          AND t.booked_at < (($4::date + 1)::timestamp AT TIME ZONE $5::text)
          AND t.amount < 0
        GROUP BY t.category, a.currency
        ORDER BY a.currency, sum(t.amount)`,
      [q.customerId, q.accountId ?? null, q.from, q.to, this.timeZone],
    );
    return rows;
  }
}
