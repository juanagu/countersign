import type { Deadline } from './deadline.js';
import type { StepUpGrant, VerifyStepUp } from './step-up-verifier.js';
import { grantMatchesDraft } from './transfer-rules.js';
import type { ExecuteDraftRefusal, TransferReceipt, TransfersRepository } from './transfers-repository.js';

export type ExecuteTransferErrorCode = ExecuteDraftRefusal;

/** The whole server-side handling of one `execute_transfer`, below the gateway's 10 s backend timeout. */
export const EXECUTE_CALL_BUDGET_MS = 6000;
/** The step-up check may fetch the IdP's keys on a cold cache; it gets no more than this of the budget. */
const VERIFY_STEP_UP_CAP_MS = 2000;

export type ExecuteTransferResult =
  | { ok: true; value: { receipt: TransferReceipt } }
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
  not_executed: 'No pude procesar la confirmación y no se ejecutó nada. Confirmá de nuevo con tu PIN en unos segundos.',
};

const failure = (code: ExecuteTransferErrorCode): ExecuteTransferResult => ({
  ok: false,
  error: { code, message: MESSAGES[code] },
});

/**
 * Executes one draft for `customerId` with a step-up token (security rule 3). The token must verify, belong
 * to the caller and name this draft. The repository checks ownership and the grant (`grantMatchesDraft`) on the
 * draft it locks, then spends the token and executes the draft in one transaction, so `token_already_used` only
 * ever means "spent, nothing moved with it, draft still pending". Execution is idempotent per draft. Everything
 * runs inside `deadline`. A step-up check that cannot answer (the IdP's keys unreachable, or too slow) ran nothing,
 * so it is `not_executed`, as it is from the repository. An error thrown by the execution itself propagates,
 * because its outcome is unknown.
 */
export async function executeTransfer(
  { repo, verifyStepUp, now }: ExecuteTransferDeps,
  customerId: string,
  draftId: string,
  stepUpToken: string,
  deadline: Deadline,
): Promise<ExecuteTransferResult> {
  let grant: StepUpGrant | undefined;
  try {
    grant = await deadline.bound(verifyStepUp(stepUpToken), VERIFY_STEP_UP_CAP_MS);
  } catch {
    return failure('not_executed');
  }
  if (!grant || grant.sub !== customerId || grant.authorization.draftId !== draftId) return failure('not_authorised');
  const { amount, currency, beneficiaryId } = grant.authorization;
  const authorised = { amount, currency, beneficiaryId };
  const outcome = await repo.executeDraft(
    { draftId, customerId, jti: grant.jti, isAuthorised: (locked) => grantMatchesDraft(locked, authorised), deadline },
    now,
  );
  if (outcome.status === 'refused') return failure(outcome.code);
  return { ok: true, value: { receipt: outcome.receipt } };
}
