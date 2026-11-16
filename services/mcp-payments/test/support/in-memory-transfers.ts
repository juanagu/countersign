import type {
  Beneficiary,
  SourceAccount,
  ExecuteDraftOutcome,
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
    accountRef: '2850590940090418135201',
    currency: 'ARS',
  },
];

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
  readonly executions = new Map<string, { receipt: TransferReceipt; jti: string }>();
  /** Every debit applied, so tests can assert a draft moved money exactly once. */
  readonly debits: { draftId: string; amount: string }[] = [];
  /** Set while another call holds the draft's lock past the wait limit. */
  lockHeldElsewhere = false;

  async findDraft(id: string) {
    return this.drafts.find((d) => d.id === id);
  }

  /** The same contract as the Postgres repository; the body has no await, so a call is atomic like the locked transaction. */
  async executeDraft(draftId: string, jti: string, clock: () => Date): Promise<ExecuteDraftOutcome> {
    if (this.lockHeldElsewhere) return { status: 'in_progress' };
    const draft = this.drafts.find((d) => d.id === draftId);
    if (draft?.status === 'executed') return this.replay(draftId, jti);
    if (draft?.status !== 'pending') return { status: 'not_pending' };
    if (this.usedJtis.has(jti)) return { status: 'token_already_used' };
    this.usedJtis.set(jti, draftId);
    const now = clock();
    if (new Date(draft.expiresAt).getTime() <= now.getTime()) return { status: 'expired' };
    if (draft.amount === INSUFFICIENT_AMOUNT) return { status: 'insufficient_funds' };
    draft.status = 'executed';
    this.debits.push({ draftId, amount: draft.amount });
    const receipt = { transferId: `trf_${draftId}`, draftId, reference: 'BD-TEST', executedAt: now.toISOString() };
    this.executions.set(draftId, { receipt, jti });
    return { status: 'executed', receipt };
  }

  private replay(draftId: string, jti: string): ExecuteDraftOutcome {
    const execution = this.executions.get(draftId);
    if (!execution || (this.usedJtis.has(jti) && execution.jti !== jti)) return { status: 'not_pending' };
    return { status: 'already_executed', receipt: execution.receipt };
  }
}
