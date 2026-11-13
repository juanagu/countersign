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

export interface TransferReceipt {
  transferId: string;
  draftId: string;
  reference: string;
  executedAt: string;
}

export type ExecuteDraftOutcome =
  | { status: 'executed'; receipt: TransferReceipt }
  /** Another call executed this draft first: same receipt, no second debit. */
  | { status: 'already_executed'; receipt: TransferReceipt }
  | { status: 'not_pending' }
  | { status: 'insufficient_funds' };

/** The transfers feature's port onto bank data. */
export interface TransfersRepository {
  listBeneficiaries(customerId: string): Promise<Beneficiary[]>;
  /** Unscoped lookups; callers check `customerId` against the caller. */
  findBeneficiary(id: string): Promise<Beneficiary | undefined>;
  findAccount(id: string): Promise<SourceAccount | undefined>;
  createDraft(draft: TransferDraft): Promise<void>;
  findDraft(id: string): Promise<TransferDraft | undefined>;
  findReceipt(draftId: string): Promise<TransferReceipt | undefined>;
  /** Records a step-up token id; false if it was already used (single use). */
  claimTokenId(jti: string): Promise<boolean>;
  /** Debits, records the transfer and marks the draft executed, atomically and at most once per draft. */
  executeDraft(draftId: string, now: Date): Promise<ExecuteDraftOutcome>;
}
