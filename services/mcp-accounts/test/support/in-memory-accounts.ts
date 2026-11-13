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

/** Mirrors the Postgres repository's scoping: list queries only see the customer's own accounts. */
export class InMemoryAccountsRepository implements AccountsRepository {
  async listAccounts(customerId: string) {
    return ACCOUNTS.filter((a) => a.customerId === customerId);
  }

  async findAccount(accountId: string) {
    return ACCOUNTS.find((a) => a.id === accountId);
  }

  async listTransactions(q: TransactionQuery) {
    const owned = new Set((await this.listAccounts(q.customerId)).map((a) => a.id));
    return TRANSACTIONS.filter((t) => owned.has(t.accountId) && (!q.accountId || t.accountId === q.accountId)).slice(
      0,
      q.limit,
    );
  }

  async spendingByCategory(q: SpendingQuery): Promise<CategorySpend[]> {
    const txs = await this.listTransactions({ customerId: q.customerId, limit: 1000 });
    return txs.map((t) => ({ category: t.category, currency: t.currency, total: t.amount.slice(1), count: 1 }));
  }
}
