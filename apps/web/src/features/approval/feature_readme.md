# approval

Human approval plus step-up for money movement (security rule 3).

## Exposed interface

- `TransferApproval`: mount inside `CopilotKitProvider`. It registers `useInterrupt` and renders
  `ApprovalPanel` in the chat when the bot pauses `execute_transfer`.
- `ApprovalPanel` (`draft`, `onDecide`), `PinDialog`.
- `lib/step-up-api.ts`: `requestStepUp(draft, pin)` → step-up token (`POST /api/auth/step-up`).
- `lib/find-confirm-card.ts`: `findConfirmCard(messages, draftId)`.
- `lib/approval-decision.ts`: `confirmTransfer(guard, draft, pin, deps)`, `cancelTransfer(guard, onDecide)`.
- `lib/interrupt-answer.ts`: `withoutStepUpAnswers(messages)`, run once `resolve` settles: CopilotKit's answer
  message carries the step-up token and would otherwise ride along with every later request.

## Data flow

Interrupt (`metadata.draft_id`, set by bot code) → the panel shows the matching `transfer-confirm` server
template (never the interrupt's model-proposed args) → Confirmar → PIN → step-up token bound to the
draft's id, amount, currency and beneficiary → `resolve({approved: true, editedArgs: {draft_id,
step_up_token}})`. Cancelar resumes with `approved: false`. A ref guard, held from the step-up to the end of
the resume, keeps a double click from deciding twice. A failed resume frees it and shows "No pudimos completar
la confirmación"; after a failed confirm the PIN dialog reopens empty, since the step-up token is single-use
and may already be spent.
