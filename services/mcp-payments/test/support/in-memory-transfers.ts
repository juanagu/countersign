import type {
  Beneficiary,
  SourceAccount,
  ExecuteDraftOutcome,
  TransferDraft,
  TransferReceipt,
  TransfersRepository,
} from '../../src/features/transfers/transfers-repository.js';

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

  readonly usedJtis = new Set<string>();
  readonly receipts = new Map<string, TransferReceipt>();
  /** Every debit applied, so tests can assert a draft moved money exactly once. */
  readonly debits: { draftId: string; amount: string }[] = [];

  async findDraft(id: string) {
    return this.drafts.find((d) => d.id === id);
  }

  async findReceipt(draftId: string) {
    return this.receipts.get(draftId);
  }

  async claimTokenId(jti: string) {
    if (this.usedJtis.has(jti)) return false;
    this.usedJtis.add(jti);
    return true;
  }

  async executeDraft(draftId: string, now: Date): Promise<ExecuteDraftOutcome> {
    const draft = this.drafts.find((d) => d.id === draftId);
    const existing = this.receipts.get(draftId);
    if (draft?.status === 'executed' && existing) return { status: 'already_executed', receipt: existing };
    if (draft?.status !== 'pending') return { status: 'not_pending' };
    draft.status = 'executed';
    this.debits.push({ draftId, amount: draft.amount });
    const receipt = { transferId: `trf_${draftId}`, draftId, reference: 'BD-TEST', executedAt: now.toISOString() };
    this.receipts.set(draftId, receipt);
    return { status: 'executed', receipt };
  }
}
