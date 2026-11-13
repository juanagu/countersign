# approval

Human approval plus step-up for money movement (security rule 3).

## Exposed interface

- `TransferApproval`: mount inside `CopilotKitProvider`. It registers `useInterrupt` and renders
  `ApprovalPanel` in the chat when the bot pauses `execute_transfer`.
- `ApprovalPanel` (`draft`, `onDecide`), `PinDialog`.
- `lib/step-up-api.ts`: `requestStepUp(draft, pin)` → step-up token (`POST /api/auth/step-up`).
- `lib/find-confirm-card.ts`: `findConfirmCard(messages, draftId)`.

## Data flow

Interrupt (`metadata.draft_id`, set by bot code) → the panel shows the matching `transfer-confirm` server
template (never the interrupt's model-proposed args) → Confirmar → PIN → step-up token bound to the
draft's id, amount, currency and beneficiary → `resolve({approved: true, editedArgs: {draft_id,
step_up_token}})`. Cancelar resumes with `approved: false`. A ref guard keeps a double click from
deciding twice.
