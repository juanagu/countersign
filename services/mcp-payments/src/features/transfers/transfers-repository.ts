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

/** Why an execution was refused. The wire codes of `execute_transfer`, so the repository's answer needs no mapping. */
export type ExecuteDraftRefusal =
  | 'not_authorised'
  /** The token was spent by an earlier attempt that moved nothing, and the draft is still pending. */
  | 'token_already_used'
  | 'draft_not_pending'
  /** The draft expired by the time its row lock was taken. Nothing is spent. */
  | 'draft_expired'
  | 'insufficient_funds'
  /** The draft's lock stayed taken past the wait limit: another call on this draft holds it. Nothing was spent. */
  | 'execution_in_progress'
  /** The source account's row stayed locked by another transfer past the wait limit. Everything rolled back. */
  | 'account_busy';

/** What the step-up token authorises; the repository compares it with the draft it reads under the lock. */
export interface AuthorisedTransfer {
  amount: string;
  currency: string;
  beneficiaryId: string;
}

export interface ExecuteDraftRequest {
  draftId: string;
  /** The step-up token's `jti`. */
  jti: string;
  authorised: AuthorisedTransfer;
}

export type ExecuteDraftOutcome =
  | { status: 'executed'; receipt: TransferReceipt }
  /**
   * The draft was executed already: the receipt of that one execution, no second debit. Answered to the token
   * that executed it and to a token nothing has spent yet; a token spent elsewhere gets `draft_not_pending`.
   */
  | { status: 'already_executed'; receipt: TransferReceipt }
  | { status: 'refused'; code: ExecuteDraftRefusal };

/** The transfers feature's port onto bank data. */
export interface TransfersRepository {
  listBeneficiaries(customerId: string): Promise<Beneficiary[]>;
  /** Unscoped lookups; callers check `customerId` against the caller. */
  findBeneficiary(id: string): Promise<Beneficiary | undefined>;
  findAccount(id: string): Promise<SourceAccount | undefined>;
  createDraft(draft: TransferDraft): Promise<void>;
  findDraft(id: string): Promise<TransferDraft | undefined>;
  /**
   * Executes the draft with the step-up token in one transaction under the draft's row lock, at most once per
   * draft, within a total time budget (ADR 023). `authorised` is compared with the draft read under the lock
   * (a mismatch spends nothing). The token is spent in that transaction once the draft is found pending and
   * unexpired, and the transfer records it, so a replay is answered from what happened: the receipt for the
   * token that executed, `draft_not_pending` for a spent token on an executed draft, `token_already_used` only
   * when that token moved nothing and the draft is pending. `now` is read once the draft is locked, so a call
   * that waited on the lock still sees the expiry. An error thrown here leaves the outcome unknown to the caller.
   */
  executeDraft(request: ExecuteDraftRequest, now: () => Date): Promise<ExecuteDraftOutcome>;
}
