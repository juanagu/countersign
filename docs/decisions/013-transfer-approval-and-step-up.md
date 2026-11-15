# 013 — Transfer approval: AG-UI interrupt, step-up token in the approved arguments, RAR binding checked by the resource server

## Context
Security rule 3: `execute_transfer` needs human approval plus step-up, and `mcp-payments` executes only if
the token's signature, `aud`, `exp`, unused `jti` and `authorization_details` all match the stored draft.

## Decision
- **Pause:** the tool policy marks T3 calls `needs_approval`. `PolicyToolset` raises `ApprovalRequired`
  with metadata `{tool, draft_id}` built in code. The agent's output type includes `DeferredToolRequests`,
  so `AGUIAdapter` ends the run as an AG-UI interrupt (`RUN_FINISHED` with `outcome.type = "interrupt"`).
  CopilotKit v2's `useInterrupt` renders the approval in the chat. No workaround was needed.
- **The model never holds the step-up token:** `step_up_token` is removed from the T3 tool schema the model
  sees, and any model-supplied `step_up_token` on a non-approval call is refused. The web app resumes with
  `{approved: true, editedArgs: {draft_id, step_up_token}}` (`status: "resolved"`), which Pydantic AI
  turns into `ToolApproved(override_args=…)`. A cancel resumes with `approved: false`.
- **CopilotKit's tool answer is dropped:** CopilotKit 1.87's `useInterrupt` `resolve(payload)` first adds a
  `role: "tool"` message for the paused call whose content is the payload, step-up token included, and keeps
  it in every later request. Pydantic AI then refuses the resume ("already executed and its result cannot be
  overridden"), and on later turns the model would read the token. `BankAGUIAdapter` drops every client tool
  message that answers a call named in `resume`, and any client tool message whose `editedArgs` carry
  `step_up_token`, before the history is loaded: the resume entry decides the call, and an older answer is
  followed by the call's real result (or Pydantic AI marks the call interrupted). The web app also removes
  that message from `agent.messages` once `resolve` settles, so the spent token stops travelling.
  `override_args` reaches only the tool call itself: the history keeps the model's arguments (`draft_id`).
- **A failed resume is recovered by asking again:** `useInterrupt` drops the interrupt when the resume run
  starts and can't resume after it fails (CopilotKit's `runAgent` swallows the failure). The chat, not the
  unmounted panel, then says "No pudimos confirmar la transferencia. Pedime de nuevo que la envíe."; the bot
  raises a new interrupt for the same draft and the customer steps up again.
- **The panel shows server data:** the approval panel looks up the `transfer-confirm` server template for
  the interrupt's `draft_id` in the thread. It never displays the interrupt's model-proposed arguments.
- **Step-up:** `POST /auth/step-up` (session, JSON, PIN `123456`, a third wrong PIN within 15 min of the streak's first locks it for 5 min from that failure; older failures are forgotten, so a typo days later can't lock anyone out; a wrong PIN that lands during the lock restarts the 5 minutes and never lifts it, and the lock is checked again after the body is read, so wrong PINs sent in parallel still get three guesses) signs
  exactly the draft values the app sends as `authorization_details: [{type: "transfer", draft_id, amount,
  currency, beneficiary_id}]`. The token has `aud=mcp-payments`, a 2-minute TTL, `token_use: "step_up"` and
  no `act`, so it can't pass as an access token. The IdP doesn't read the payments database: the resource
  server is the one that compares the grant with its stored draft, as RAR intends.
- **Execute (`mcp-payments`):** the caller's access token needs scope `transfers:execute`. Then check the
  step-up token (signature, issuer, `aud`, `exp`, `token_use`, scope `transfers:execute`), then that
  `sub` is the caller and the draft id matches. Claim the `jti` before anything else can fail (single use,
  so a double click is refused). Then the grant must equal the draft (amount, currency, beneficiary) and
  the draft must be pending and unexpired. Execution runs in one transaction under the draft's row lock,
  which re-checks status and expiry with the clock read after the lock is taken, so a call that waited on the
  lock can't execute a draft that expired meanwhile (`draft_expired`); a second valid token for an executed
  draft returns the same receipt without a second debit.
- **Resume needs its skill:** each run restores the skills loaded by earlier `load_skill` calls in its
  history. Otherwise the resumed `execute_transfer` would not be visible. Pre-loading grants no capability
  beyond the user's tokens and the policy. History becomes server-owned in Phase 7.

## Consequences
Scenario 3 runs end to end. A forged history can at most pre-load skill instructions. The receipt card
comes from the `execute_transfer` result through `TemplateToolset`, like the confirm card.
