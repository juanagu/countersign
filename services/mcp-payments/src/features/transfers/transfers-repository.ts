export type Currency = 'ARS' | 'USD';

export interface SourceAccount {
  id: string;
  customerId: string;
  currency: Currency;
  alias: string;
  number: string;
  balance: string;
}

export interface Beneficiary {
  id: string;
  customerId: string;
  fullName: string;
  bankName: string;
  accountRef: string;
  currency: Currency;
}

export interface TransferDraft {
  id: string;
  customerId: string;
  sourceAccountId: string;
  beneficiaryId: string;
  /** Decimal strings, two places. */
  amount: string;
  fee: string;
  currency: Currency;
  status: 'pending' | 'executed' | 'expired' | 'cancelled';
  expiresAt: string;
}

/** The transfers feature's port onto bank data. */
export interface TransfersRepository {
  listBeneficiaries(customerId: string): Promise<Beneficiary[]>;
  /** Unscoped lookups; callers check `customerId` against the caller. */
  findBeneficiary(id: string): Promise<Beneficiary | undefined>;
  findAccount(id: string): Promise<SourceAccount | undefined>;
  createDraft(draft: TransferDraft): Promise<void>;
}
