import type { VerifyStepUp } from './step-up-verifier.js';
import type { TransferDraft, TransferReceipt, TransfersRepository } from './transfers-repository.js';

export type ExecuteTransferErrorCode =
  | 'not_authorised'
  | 'token_already_used'
  | 'draft_not_found'
  | 'draft_expired'
  | 'draft_not_pending'
  | 'insufficient_funds';

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
  token_already_used: 'Esa confirmación ya se usó. Confirmá de nuevo si querés reintentar.',
  draft_not_found: 'No encontré esa transferencia preparada.',
  draft_expired: 'La transferencia preparada venció. Preparala de nuevo.',
  draft_not_pending: 'Esa transferencia ya no está pendiente.',
  insufficient_funds: 'El saldo disponible ya no alcanza para esta transferencia.',
};

const failure = (code: ExecuteTransferErrorCode): ExecuteTransferResult => ({
  ok: false,
  error: { code, message: MESSAGES[code] },
});

function matchesDraft(draft: TransferDraft, auth: { amount: string; currency: string; beneficiaryId: string }) {
  return draft.amount === auth.amount && draft.currency === auth.currency && draft.beneficiaryId === auth.beneficiaryId;
}

const LOCKED_FAILURES = {
  not_pending: 'draft_not_pending',
  expired: 'draft_expired',
  insufficient_funds: 'insufficient_funds',
} as const satisfies Record<string, ExecuteTransferErrorCode>;

/**
 * Executes one draft for `customerId` with a step-up token (security rule 3). The token must verify, belong
 * to the caller, name this draft and be unused; its authorised amount, currency and beneficiary must equal
 * the stored draft. Execution is idempotent per draft.
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
  // Claimed before anything else can fail, so a token is spent even by a rejected attempt.
  if (!(await repo.claimTokenId(grant.jti))) return failure('token_already_used');
  if (!matchesDraft(draft, grant.authorization)) return failure('not_authorised');

  if (draft.status === 'executed') {
    const receipt = await repo.findReceipt(draftId);
    return receipt ? { ok: true, value: { draft, receipt } } : failure('draft_not_pending');
  }
  if (draft.status !== 'pending') return failure('draft_not_pending');
  if (new Date(draft.expiresAt).getTime() <= now().getTime()) return failure('draft_expired');

  const outcome = await repo.executeDraft(draftId, now);
  if (outcome.status === 'executed' || outcome.status === 'already_executed') {
    return { ok: true, value: { draft, receipt: outcome.receipt } };
  }
  return failure(LOCKED_FAILURES[outcome.status]);
}
