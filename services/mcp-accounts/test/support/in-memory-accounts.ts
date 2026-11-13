import type {
  Account,
  AccountsRepository,
  CategorySpend,
  SpendingQuery,
  Transaction,
  TransactionQuery,
} from '../../src/features/accounts/accounts-repository.js';

export const ACCOUNTS: Account[] = [
  {
    id: 'acc-ana-ars',
    customerId: 'ana',
    kind: 'savings',
    currency: 'ARS',
    alias: 'Pesos',
    number: '0170-0001-4521',
    balance: '1000.00',
  },
  {
    id: 'acc-juan-ars',
    customerId: 'juan',
    kind: 'checking',
    currency: 'ARS',
    alias: 'Pesos',
    number: '0170-0002-7810',
    balance: '500.00',
  },
];

const TRANSACTIONS: Transaction[] = [
  {
    id: '1',
    accountId: 'acc-ana-ars',
    bookedAt: '2026-10-05T10:00:00.000Z',
    amount: '-100.00',
    currency: 'ARS',
    category: 'supermercado',
    merchant: 'Super',
    memo: null,
  },
  {
    id: '3',
    accountId: 'acc-ana-ars',
    bookedAt: '2026-10-20T23:30:00.000Z',
    amount: '-40.50',
    currency: 'ARS',
    category: 'restaurantes',
    merchant: 'Bodegón',
    memo: null,
  },
  {
    id: '4',
    accountId: 'acc-ana-ars',
    bookedAt: '2026-10-31T12:00:00.000Z',
    amount: '1500.00',
    currency: 'ARS',
    category: 'sueldo',
    merchant: 'Empleador',
    memo: null,
  },
  {
    id: '5',
    accountId: 'acc-ana-ars',
    bookedAt: '2026-11-02T09:00:00.000Z',
    amount: '-60.00',
    currency: 'ARS',
    category: 'supermercado',
    merchant: 'Super',
    memo: null,
  },
  {
    id: '2',
    accountId: 'acc-juan-ars',
    bookedAt: '2026-10-06T10:00:00.000Z',
    amount: '-250.00',
    currency: 'ARS',
    category: 'restaurantes',
    merchant: 'Parrilla',
    memo: null,
  },
];

/** Mirrors the Postgres repository: customer scoping, period and category filters, ordering and spend totals. */
export class InMemoryAccountsRepository implements AccountsRepository {
  async listAccounts(customerId: string) {
    return ACCOUNTS.filter((a) => a.customerId === customerId);
  }

  async findAccount(accountId: string) {
    return ACCOUNTS.find((a) => a.id === accountId);
  }

  async listTransactions(q: TransactionQuery) {
    const owned = new Set((await this.listAccounts(q.customerId)).map((a) => a.id));
    return TRANSACTIONS.filter(
      (t) =>
        owned.has(t.accountId) &&
        (!q.accountId || t.accountId === q.accountId) &&
        inPeriod(t, q.from, q.to) &&
        (!q.category || t.category === q.category),
    )
      .sort((a, b) => b.bookedAt.localeCompare(a.bookedAt))
      .slice(0, q.limit);
  }

  async spendingByCategory(q: SpendingQuery): Promise<CategorySpend[]> {
    const { customerId, accountId, from, to } = q;
    const debits = (
      await this.listTransactions({ customerId, ...(accountId && { accountId }), from, to, limit: Infinity })
    ).filter((t) => t.amount.startsWith('-'));
    const groups = new Map<string, CategorySpend & { cents: number }>();
    for (const t of debits) {
      const key = `${t.currency}/${t.category}`;
      const group = groups.get(key) ?? { category: t.category, currency: t.currency, total: '', count: 0, cents: 0 };
      group.cents += Math.round(-Number(t.amount) * 100);
      group.count += 1;
      groups.set(key, group);
    }
    return [...groups.values()]
      .sort((a, b) => a.currency.localeCompare(b.currency) || b.cents - a.cents)
      .map(({ cents, ...spend }) => ({ ...spend, total: (cents / 100).toFixed(2) }));
  }
}

/** Like the Postgres query: `from` and `to` are whole UTC days, both inclusive. */
function inPeriod(t: Transaction, from: string | undefined, to: string | undefined): boolean {
  const day = t.bookedAt.slice(0, 'YYYY-MM-DD'.length);
  return (!from || day >= from) && (!to || day <= to);
}
