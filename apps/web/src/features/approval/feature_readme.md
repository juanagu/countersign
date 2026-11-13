# approval

Human approval plus step-up for money movement (security rule 3).

## Exposed interface

- `TransferApproval` (`setResumeFailed`): mount inside `CopilotKitProvider`. It registers `useInterrupt` and
  renders `ApprovalPanel` in the chat when the bot pauses `execute_transfer`, and reports a failed approval
  resume through `setResumeFailed`.
- `lib/resume-outcome.ts`: `RESUME_FAILED_NOTICE`, `showsResumeFailed(shown, signal, input)`; the chat screen
  shows the notice in its alert slot, outside the interrupt element.
- `ApprovalPanel` (`draft`, `onDecide`), `PinDialog`.
- `lib/step-up-api.ts`: `requestStepUp(draft, pin)` → step-up token (`POST /api/auth/step-up`).
- `lib/find-confirm-card.ts`: `findConfirmCard(messages, draftId)`.
- `lib/approval-decision.ts`: `confirmTransfer(guard, draft, pin, deps)`, `cancelTransfer(guard, onDecide)`.
- `lib/pin-entry.ts`: `pinErrorAfter(event)`, `canSubmitPin(pin, pending, error)`. A step-up error clears when the
  dialog reopens or the PIN changes, so a 5-minute lockout can't keep the dialog disabled after it expires.
- `lib/interrupt-answer.ts`: `withoutStepUpAnswers(messages)`, run once `resolve` settles: CopilotKit's answer
  message carries the step-up token and would otherwise ride along with every later request.

## Data flow

Interrupt (`metadata.draft_id`, set by bot code) → the panel shows the matching `transfer-confirm` server
template (never the interrupt's model-proposed args) → Confirmar → PIN → step-up token bound to the
draft's id, amount, currency and beneficiary → `resolve({approved: true, editedArgs: {draft_id,
step_up_token}})`. Cancelar resumes with `approved: false`. A ref guard, held from the step-up on, keeps a
double click from deciding twice; only a failed step-up frees it.

`useInterrupt` unmounts the panel when the resume run starts, and after a failed run it can't resume again:
CopilotKit's `runAgent` swallows the failure, so `resolve` doesn't even reject. `TransferApproval`, which stays
mounted, watches the agent's run events instead: when a run resuming an approval ends in `RUN_ERROR` or fails,
the chat shows "No pudimos confirmar la transferencia. Pedime de nuevo que la envíe." until the next run starts.
Asking again makes the bot raise a new interrupt for the same draft, with a new step-up; `mcp-payments` never
debits a draft twice.
