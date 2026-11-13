export interface Account {
  id: string;
  customerId: string;
  kind: 'savings' | 'checking';
  currency: 'ARS' | 'USD';
  alias: string;
  number: string;
  /** Decimal string, two places. */
  balance: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  bookedAt: string;
  /** Decimal string; negative is a debit. */
  amount: string;
  currency: string;
  category: string;
  merchant: string;
  memo: string | null;
}

export interface TransactionQuery {
  customerId: string;
  accountId?: string;
  from?: string;
  to?: string;
  category?: string;
  limit: number;
}

export interface CategorySpend {
  category: string;
  currency: string;
  /** Positive decimal string: total debits. */
  total: string;
  count: number;
}

export interface SpendingQuery {
  customerId: string;
  accountId?: string;
  from: string;
  to: string;
}

/** The accounts feature's port onto bank data. Every query that lists data is scoped to a customer. */
export interface AccountsRepository {
  listAccounts(customerId: string): Promise<Account[]>;
  /** Unscoped lookup; callers must check `customerId` against the caller. */
  findAccount(accountId: string): Promise<Account | undefined>;
  listTransactions(query: TransactionQuery): Promise<Transaction[]>;
  spendingByCategory(query: SpendingQuery): Promise<CategorySpend[]>;
}
