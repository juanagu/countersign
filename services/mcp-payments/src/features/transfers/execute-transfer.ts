import type { VerifyStepUp } from './step-up-verifier.js';
import type {
  ExecuteDraftRefusal,
  TransferDraft,
  TransferReceipt,
  TransfersRepository,
} from './transfers-repository.js';

export type ExecuteTransferErrorCode = ExecuteDraftRefusal | 'draft_not_found';

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
  account_busy:
    'La cuenta de origen está ocupada con otra operación. Esperá unos segundos y confirmá de nuevo con tu PIN.',
};

const failure = (code: ExecuteTransferErrorCode): ExecuteTransferResult => ({
  ok: false,
  error: { code, message: MESSAGES[code] },
});

/**
 * Executes one draft for `customerId` with a step-up token (security rule 3). The token must verify, belong
 * to the caller and name this draft. The repository compares its authorised amount, currency and beneficiary
 * with the draft it reads under the lock (a mismatch spends nothing), then spends the token and executes the
 * draft in one transaction, so `token_already_used` only ever means "spent, nothing moved with it, draft still pending"
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
  const outcome = await repo.executeDraft(
    {
      draftId,
      jti: grant.jti,
      authorised: {
        amount: grant.authorization.amount,
        currency: grant.authorization.currency,
        beneficiaryId: grant.authorization.beneficiaryId,
      },
    },
    now,
  );
  if (outcome.status === 'refused') return failure(outcome.code);
  return { ok: true, value: { draft, receipt: outcome.receipt } };
}
