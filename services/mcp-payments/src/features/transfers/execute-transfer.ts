import type { VerifyStepUp } from './step-up-verifier.js';
import type { TransferDraft, TransferReceipt, TransfersRepository } from './transfers-repository.js';

export type ExecuteTransferErrorCode =
  | 'not_authorised'
  | 'token_already_used'
  | 'draft_not_found'
  | 'draft_expired'
  | 'draft_not_pending'
  | 'insufficient_funds'
  | 'execution_in_progress';

export type ExecuteTransferResult =
  | { ok: true; value: { draft: TransferDraft; receipt: TransferReceipt } }
  | { ok: false; error: { code: ExecuteTransferErrorCode; message: string } };

export interface ExecuteTransferDeps {
  repo: TransfersRepository;
  verifyStepUp: VerifyStepUp;
  now: () => Date;
}

const MESSAGES: Record<ExecuteTransferErrorCode, string> = {
  not_authorised: 'La transferencia no está autorizada.',
  token_already_used: 'Esa confirmación ya se usó. Confirmá de nuevo con tu PIN.',
  draft_not_found: 'No encontré esa transferencia preparada.',
  draft_expired: 'La transferencia preparada venció. Preparala de nuevo.',
  draft_not_pending: 'Esa transferencia ya no está pendiente.',
  insufficient_funds: 'El saldo disponible ya no alcanza para esta transferencia.',
  execution_in_progress: 'La transferencia se está procesando. Esperá unos segundos y confirmá de nuevo con tu PIN.',
};

const failure = (code: ExecuteTransferErrorCode): ExecuteTransferResult => ({
  ok: false,
  error: { code, message: MESSAGES[code] },
});

function matchesDraft(draft: TransferDraft, auth: { amount: string; currency: string; beneficiaryId: string }) {
  return draft.amount === auth.amount && draft.currency === auth.currency && draft.beneficiaryId === auth.beneficiaryId;
}

const REFUSED_OUTCOMES = {
  token_already_used: 'token_already_used',
  not_pending: 'draft_not_pending',
  expired: 'draft_expired',
  insufficient_funds: 'insufficient_funds',
  in_progress: 'execution_in_progress',
} as const satisfies Record<string, ExecuteTransferErrorCode>;

/**
 * Executes one draft for `customerId` with a step-up token (security rule 3). The token must verify, belong
 * to the caller and name this draft, and its authorised amount, currency and beneficiary must equal the stored
 * draft (a mismatch spends nothing). The repository then spends the token and executes the draft in one
 * transaction, so `token_already_used` only ever means "spent, nothing moved with it, draft still pending"
 * (ADR 023). Execution is idempotent per draft.
 */
export async function executeTransfer(
  { repo, verifyStepUp, now }: ExecuteTransferDeps,
  customerId: string,
  draftId: string,
  stepUpToken: string,
): Promise<ExecuteTransferResult> {
  const grant = await verifyStepUp(stepUpToken);
  if (!grant || grant.sub !== customerId || grant.authorization.draftId !== draftId) return failure('not_authorised');

  const draft = await repo.findDraft(draftId);
  if (draft?.customerId !== customerId) return failure('draft_not_found');
  // A draft's amount, currency and beneficiary never change, so this read needs no lock.
  if (!matchesDraft(draft, grant.authorization)) return failure('not_authorised');

  const outcome = await repo.executeDraft(draftId, grant.jti, now);
  if (outcome.status === 'executed' || outcome.status === 'already_executed') {
    return { ok: true, value: { draft, receipt: outcome.receipt } };
  }
  return failure(REFUSED_OUTCOMES[outcome.status]);
}
