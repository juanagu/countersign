import type { TransferConfirmData } from '@poc/contracts';
import { StepUpFailed, type StepUpError } from './step-up-api';

/** The resume payload Pydantic AI expects: `editedArgs` replaces the tool call's arguments. */
export interface ApprovalDecision {
  approved: boolean;
  editedArgs?: { draft_id: string; step_up_token: string };
  reason?: string;
}

/** Settles once CopilotKit's resume run ends; a failure is reported by the chat, not here (see `resume-outcome`). */
export type OnDecide = (decision: ApprovalDecision) => Promise<void>;

/** A ref, not state: a double click lands before React re-renders the disabled button. */
export interface InFlight {
  current: boolean;
}

export type ApprovalError = StepUpError;

/** `busy`: another decision is in flight or done. `failed`: the step-up failed and the customer can try again. */
export type DecisionResult = { kind: 'done' } | { kind: 'busy' } | { kind: 'failed'; error: ApprovalError };

const CANCEL: ApprovalDecision = { approved: false, reason: 'El cliente canceló la transferencia.' };
const DONE: DecisionResult = { kind: 'done' };
const BUSY: DecisionResult = { kind: 'busy' };
const failed = (error: ApprovalError): DecisionResult => ({ kind: 'failed', error });

/** The guard stays held: CopilotKit answers an interrupt once, so after a resume there is nothing left to decide. */
async function resume(onDecide: OnDecide, decision: ApprovalDecision): Promise<DecisionResult> {
  await onDecide(decision);
  return DONE;
}

export async function cancelTransfer(guard: InFlight, onDecide: OnDecide): Promise<DecisionResult> {
  if (guard.current) return BUSY;
  guard.current = true;
  return resume(onDecide, CANCEL);
}

/** Step-up, then resume. The guard covers both, so a second click can't start a second step-up. */
export async function confirmTransfer(
  guard: InFlight,
  draft: TransferConfirmData,
  pin: string,
  deps: { stepUp: (draft: TransferConfirmData, pin: string) => Promise<string>; onDecide: OnDecide },
): Promise<DecisionResult> {
  if (guard.current) return BUSY;
  guard.current = true;
  let token: string;
  try {
    token = await deps.stepUp(draft, pin);
  } catch (failure) {
    guard.current = false;
    return failed(failure instanceof StepUpFailed ? failure.reason : 'failed');
  }
  return resume(deps.onDecide, {
    approved: true,
    editedArgs: { draft_id: draft.draftId, step_up_token: token },
  });
}
