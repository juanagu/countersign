# approval

Human approval plus step-up for money movement (security rule 3).

## Exposed interface

- `TransferApproval` (`resumeFailed`, `setResumeFailed`, `children`): wraps the chat inside `CopilotKitProvider`.
  It registers `useInterrupt({ renderInChat: false })` and publishes the open interrupt (`draftId`, `decide`)
  and `resumeFailed` through `approval-context.tsx` (`useApproval`); nothing is rendered below the card. If the
  thread has no confirm card for the draft, `MissingDraftCard` ("No encontramos el borrador…", Descartar) goes
  into CopilotKit's interrupt slot instead.
- `useConfirmCard(draft)` (`use-confirm-card.ts`): `{ state, decide }` for a confirm card in the thread, from
  `confirmCardState` (`lib/confirm-card-state.ts`): `pending` (this draft's interrupt is open), `waiting` (the
  agent is running: pending layout, no buttons), `confirmed` (a receipt with the same `draftId`), `expired`,
  `not-sent` (covers cancel), `resume-failed`. `isResolved(state)` says the card collapses.
- `ApprovalPanel` (`draft`, `onDecide`): the confirm card's footer (expiry note, Cancelar, Confirmar) plus the
  `PinDialog`; the buttons are disabled while the dialog is open and focus returns to Confirmar when it closes.
  `ApprovalWaiting` is the same footer with no buttons. `ResolvedLine` (`state`, `draft`) is the collapsed card.
- `lib/resume-outcome.ts`: `RESUME_FAILED_NOTICE`, `showsResumeFailed(shown, signal, input)`; the confirm card
  shows the notice in its `resume-failed` line.
- `PinDialog` (`draft` for its summary row, which reads the server template's amount and beneficiary): a bottom
  sheet below 768, a centred 24rem dialog from 768, still a modal `<dialog>`.
- `lib/step-up-api.ts`: `requestStepUp(draft, pin)` → step-up token (`POST /api/auth/step-up`).
- `lib/find-confirm-card.ts`: `findConfirmCard(messages, draftId)`, `hasReceipt(messages, draftId)`.
- `lib/approval-decision.ts`: `confirmTransfer(guard, draft, pin, deps)`, `cancelTransfer(guard, onDecide)`.
- `lib/pin-entry.ts`: `pinErrorAfter(event)`, `canSubmitPin(pin, pending, error)`. A step-up error clears when the
  dialog reopens or the PIN changes, so a 5-minute lockout can't keep the dialog disabled after it expires.
- `lib/interrupt-answer.ts`: `withoutStepUpAnswers(messages)`, run once `resolve` settles: CopilotKit's answer
  message carries the step-up token and would otherwise ride along with every later request.

## Data flow

Interrupt (`metadata.draft_id`, set by bot code) → the matching `transfer-confirm` server template in the thread shows
its own footer (never the interrupt's model-proposed args) → Confirmar → PIN → step-up token bound to the
draft's id, amount, currency and beneficiary → `resolve({approved: true, editedArgs: {draft_id,
step_up_token}})`. Cancelar resumes with `approved: false`. A ref guard, held from the step-up on, keeps a
double click from deciding twice; only a failed step-up frees it.

`useInterrupt` clears the interrupt when the resume run starts (the card shows its pending layout without buttons), and after a failed run it can't resume again:
CopilotKit's `runAgent` swallows the failure, so `resolve` doesn't even reject. `TransferApproval`, which stays
mounted, watches the agent's run events instead: when a run resuming an approval ends in `RUN_ERROR` or fails,
the confirm card shows "No pudimos confirmar la transferencia. Pedime de nuevo que la envíe." until the next run starts.
Asking again makes the bot raise a new interrupt for the same draft, with a new step-up; `mcp-payments` never
debits a draft twice.
