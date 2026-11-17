import type { Deadline } from '../../src/features/transfers/deadline.js';
import type {
  Beneficiary,
  SourceAccount,
  ExecuteDraftOutcome,
  ExecuteDraftRefusal,
  ExecuteDraftRequest,
  TransferDraft,
  TransferReceipt,
  TransfersRepository,
} from '../../src/features/transfers/transfers-repository.js';

/** A draft of this amount finds the balance too low when it is executed. */
export const INSUFFICIENT_AMOUNT = '999999999.00';

const ACCOUNTS: SourceAccount[] = [
  {
    id: 'acc-juan-ars',
    customerId: 'juan',
    currency: 'ARS',
    alias: 'Pesos',
    number: '0170-0002-7810',
    balance: '486750.25',
  },
  {
    id: 'acc-juan-usd',
    customerId: 'juan',
    currency: 'USD',
    alias: 'Dólares',
    number: '0170-0002-7811',
    balance: '1150.00',
  },
  {
    id: 'acc-ana-ars',
    customerId: 'ana',
    currency: 'ARS',
    alias: 'Pesos',
    number: '0170-0001-4521',
    balance: '1254300.50',
  },
];

const BENEFICIARIES: Beneficiary[] = [
  {
    id: 'ben-juan-ana',
    customerId: 'juan',
    fullName: 'Ana Gómez',
    bankName: 'Banco Demo',
    accountRef: '0170000100000000045211',
    currency: 'ARS',
  },
  {
    id: 'ben-juan-pablo-usd',
    customerId: 'juan',
    fullName: 'Pablo Ruiz',
    bankName: 'Banco Demo',
    accountRef: '0170000300000000099871',
    currency: 'USD',
  },
  {
    id: 'ben-ana-lucia',
    customerId: 'ana',
    fullName: 'Lucía Fernández',
    bankName: 'Banco Austral',
    accountRef: '9990000300000000012345',
    currency: 'ARS',
  },
];

const refused = (code: ExecuteDraftRefusal): ExecuteDraftOutcome => ({ status: 'refused', code });

export class InMemoryTransfersRepository implements TransfersRepository {
  readonly drafts: TransferDraft[] = [];

  async listBeneficiaries(customerId: string) {
    return BENEFICIARIES.filter((b) => b.customerId === customerId);
  }

  async findBeneficiary(id: string) {
    return BENEFICIARIES.find((b) => b.id === id);
  }

  async findAccount(id: string) {
    return ACCOUNTS.find((a) => a.id === id);
  }

  async createDraft(draft: TransferDraft) {
    this.drafts.push(draft);
  }

  /** Spent step-up tokens and the draft each was spent on. */
  readonly usedJtis = new Map<string, string>();
  /** Each executed draft's receipt and the token that executed it. */
  readonly executions = new Map<string, { transferId: string; reference: string; executedAt: string; jti: string }>();
  /** Every debit applied, so tests can assert a draft moved money exactly once. */
  readonly debits: { draftId: string; amount: string }[] = [];
  /** Set while another call holds the draft's lock past the wait limit. */
  lockHeldElsewhere = false;
  /** Set while another transfer holds the source account's row past the wait limit. */
  accountLockHeldElsewhere = false;
  /** The deadline of each `executeDraft` call, so tests can check the call's one budget reached the repository. */
  readonly deadlines: Deadline[] = [];
  /** The error `executeDraft` throws, as a driver failure would: the caller cannot know whether it committed. */
  failWith: Error | undefined;

  /** The same contract as the Postgres repository; the body has no await, so a call is atomic like the locked transaction. */
  async executeDraft(
    { draftId, customerId, jti, isAuthorised, deadline }: ExecuteDraftRequest,
    clock: () => Date,
  ): Promise<ExecuteDraftOutcome> {
    this.deadlines.push(deadline);
    if (this.failWith) throw this.failWith;
    if (deadline.remainingMs() < 1) return refused('not_executed');
    if (this.lockHeldElsewhere) return refused('execution_in_progress');
    const draft = this.drafts.find((d) => d.id === draftId);
    if (draft?.customerId !== customerId) return refused('draft_not_found');
    if (!isAuthorised(draft)) return refused('not_authorised');
    if (draft.status === 'executed') return this.replay(draft, jti);
    if (draft.status !== 'pending') return refused('draft_not_pending');
    const now = clock();
    if (new Date(draft.expiresAt).getTime() <= now.getTime()) return refused('draft_expired');
    if (this.usedJtis.has(jti)) return refused('token_already_used');
    // The account wait comes after the token was written and rolls it back with the rest.
    if (this.accountLockHeldElsewhere) return refused('account_busy');
    this.usedJtis.set(jti, draftId);
    if (draft.amount === INSUFFICIENT_AMOUNT) return refused('insufficient_funds');
    draft.status = 'executed';
    this.debits.push({ draftId, amount: draft.amount });
    const executed = { transferId: `trf_${draftId}`, reference: 'BD-TEST', executedAt: now.toISOString() };
    this.executions.set(draftId, { ...executed, jti });
    return { status: 'executed', receipt: this.receiptOf(draft, executed) };
  }

  private replay(draft: TransferDraft, jti: string): ExecuteDraftOutcome {
    const execution = this.executions.get(draft.id);
    if (!execution || (this.usedJtis.has(jti) && execution.jti !== jti)) return refused('draft_not_pending');
    const { transferId, reference, executedAt } = execution;
    return { status: 'already_executed', receipt: this.receiptOf(draft, { transferId, reference, executedAt }) };
  }

  /** The receipt carries what the draft names, as the Postgres adapter reads it under the lock. */
  private receiptOf(
    draft: TransferDraft,
    executed: Pick<TransferReceipt, 'transferId' | 'reference' | 'executedAt'>,
  ): TransferReceipt {
    const account = ACCOUNTS.find((a) => a.id === draft.sourceAccountId) as SourceAccount;
    const beneficiary = BENEFICIARIES.find((b) => b.id === draft.beneficiaryId) as Beneficiary;
    return {
      ...executed,
      draftId: draft.id,
      amount: draft.amount,
      fee: draft.fee,
      currency: draft.currency,
      sourceAccount: { id: account.id, alias: account.alias, number: account.number },
      beneficiary: {
        id: beneficiary.id,
        fullName: beneficiary.fullName,
        bankName: beneficiary.bankName,
        accountRef: beneficiary.accountRef,
        currency: beneficiary.currency,
      },
    };
  }
}
