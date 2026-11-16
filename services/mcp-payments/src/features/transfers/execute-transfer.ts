import { Deadline } from './deadline.js';
import type { VerifyStepUp } from './step-up-verifier.js';
import { grantMatchesDraft } from './transfer-rules.js';
import type {
  ExecuteDraftRefusal,
  TransferDraft,
  TransferReceipt,
  TransfersRepository,
} from './transfers-repository.js';

export type ExecuteTransferErrorCode = ExecuteDraftRefusal | 'draft_not_found';

/**
 * The whole server-side handling of one `execute_transfer`, below the gateway's 10 s backend timeout (ADR 023): the
 * step-up check, the draft read, the execution and the receipt lookup after a commit share it.
 */
export const EXECUTE_CALL_BUDGET_MS = 6000;
/** The step-up check may fetch the IdP's keys on a cold cache; it gets no more than this of the budget. */
const VERIFY_STEP_UP_CAP_MS = 2000;

/**
 * A step before the execution (the step-up check or the draft read) failed or ran out of time. Nothing was spent
 * or moved, so the caller can answer with a definite code and leave the draft open.
 */
export class NotExecutedError extends Error {
  constructor(cause: unknown) {
    super('execute_transfer failed before the execution started', { cause });
  }
}

export type ExecuteTransferResult =
  | { ok: true; value: { draft: TransferDraft; receipt: TransferReceipt } }
  | { ok: false; error: { code: ExecuteTransferErrorCode; message: string } };

export const NOT_EXECUTED_CODE = 'not_executed';
export const NOT_EXECUTED_MESSAGE =
  'No pude procesar la confirmación y no se ejecutó nada. Confirmá de nuevo con tu PIN en unos segundos.';

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

async function beforeExecution<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (error) {
    throw new NotExecutedError(error);
  }
}

/**
 * Executes one draft for `customerId` with a step-up token (security rule 3). The token must verify, belong
 * to the caller and name this draft. The repository checks the grant (`grantMatchesDraft`) against the draft it
 * reads under the lock (a mismatch spends nothing), then spends the token and executes the draft in one
 * transaction, so `token_already_used` only ever means "spent, nothing moved with it, draft still pending"
 * (ADR 023). Execution is idempotent per draft. Everything runs inside `deadline`; a step before the execution
 * that fails or runs out of time throws `NotExecutedError`, and an error from the execution itself propagates
 * as is, because its outcome is unknown.
 */
export async function executeTransfer(
  { repo, verifyStepUp, now }: ExecuteTransferDeps,
  customerId: string,
  draftId: string,
  stepUpToken: string,
  deadline: Deadline = Deadline.after(EXECUTE_CALL_BUDGET_MS),
): Promise<ExecuteTransferResult> {
  const grant = await beforeExecution(() => deadline.bound(verifyStepUp(stepUpToken), VERIFY_STEP_UP_CAP_MS));
  if (!grant || grant.sub !== customerId || grant.authorization.draftId !== draftId) return failure('not_authorised');

  const draft = await beforeExecution(() => deadline.bound(repo.findDraft(draftId)));
  if (draft?.customerId !== customerId) return failure('draft_not_found');
  const { amount, currency, beneficiaryId } = grant.authorization;
  const authorised = { amount, currency, beneficiaryId };
  const outcome = await repo.executeDraft(
    { draftId, jti: grant.jti, isAuthorised: (locked) => grantMatchesDraft(locked, authorised), deadline },
    now,
  );
  if (outcome.status === 'refused') return failure(outcome.code);
  return { ok: true, value: { draft, receipt: outcome.receipt } };
}
