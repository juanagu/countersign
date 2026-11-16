# 023 — Step-up token replay: spend the `jti` inside the execute transaction, answer a replay from what happened

**Status:** accepted (backlog F73). Amends [ADR 013](013-transfer-approval-and-step-up.md): its "claim the `jti` before
anything else can fail (single use, so a double click is refused)" is replaced by the decision below. Everything else in
ADR 013 stands.

## Context
`mcp-payments` claimed the step-up token's `jti` in `used_jtis` before it looked at the draft, in a transaction of its
own, and nothing linked the claim to the transfer. So `token_already_used` could be the answer after money moved:

1. **A double click** while the first call was still inside `executeDraft`: the second call lost the claim and was
   refused, then the first debited.
2. **A replay of the token that executed the draft** (a retry after a lost response, a failed resume): refused, though
   the receipt existed.
3. **A stale token from an earlier rejected attempt** (the draft expired or the balance fell short, and the draft was
   later executed with a fresh token): refused with the same code.

The bank's own message could not be both true and useful, so F72 made the bot close the draft on `token_already_used`
and made the message say "start again", which told a customer whose money had moved to prepare the transfer a second
time. F72 recorded that as a stopgap.

## Decision
- **One transaction, one lock.** `executeDraft(draftId, jti, now)` takes the draft's row lock (`FOR UPDATE`) first and
  does everything under it: the grant check, the status check, expiry (with the clock read after the lock), spending
  the token, debit, movements, the transfer. Concurrent calls on a draft serialise on that lock, so the second call of a double click
  waits for the first and then sees its result instead of racing it.
- **The record.** `used_jtis` gains `draft_id` (the draft the token was spent on), and `transfers` gains
  `step_up_jti NOT NULL UNIQUE REFERENCES used_jtis (jti)`: the token that executed the draft, and the database refuses
  a transfer without a spent token. A `used_jtis` row with no transfer naming it is, by construction, a token spent by
  an attempt that moved nothing.
- **When a token is spent.** Once the draft is locked and found pending and unexpired, before the balance check. An
  expired draft spends nothing and answers `draft_expired` to any token, spent or not: it can never execute, so no
  token on it can go stale in a way that matters, and checking expiry first keeps a retry with the same token from
  being told `token_already_used` for a draft that is simply over. A draft the balance cannot cover
  (`insufficient_funds`) commits its spent token: the PIN was presented and the bank evaluated an execution. A draft
  that is not pending is answered from its record and spends nothing.
- **The grant.** The step-up token authorises an amount, currency and beneficiary. The repository compares them with
  the draft row it reads under the lock, so the check does not depend on those fields never changing, and a mismatch
  is `not_authorised` and spends nothing, whatever the draft's status.
- **Answers**, in order:

| Draft state under the lock | Token | Answer |
| --- | --- | --- |
| executed | the one that executed it (`transfers.step_up_jti`) | the same receipt, no second debit |
| executed | spent elsewhere (a rejected attempt on this draft) | `draft_not_pending` |
| executed | not spent | the receipt; the token stays unspent (it can authorise nothing on a finished draft) |
| expired, cancelled or missing | any | `draft_not_pending` |
| pending, past its expiry | any | `draft_expired`, nothing spent |
| pending | already spent | `token_already_used` |
| pending | new | spent, then executes, or `insufficient_funds` |

  The unspent-token row is ADR 013's behaviour ("a second valid token for an executed draft returns the same
  receipt"), which the failed-resume recovery depends on: the customer asks again, steps up again with a fresh token
  and gets the receipt of what already happened.
- **The invariant.** `token_already_used` means "this token was spent, nothing moved with it, and the draft is still
  pending", and nothing else.
- **In flight, and the call's deadline.** One deadline starts at the top of the `execute_transfer` callback
  (`Deadline`, 6 s) and every step shares it: the step-up check (bounded to 2 s of it, since a cold JWKS cache fetches
  the IdP's keys), the draft read, the transaction, and, after a commit, the receipt lookup (at most 1 s, outside the
  deadline because the money has moved). Inside the transaction the repository sets `lock_timeout = min(5 s, what is left)`
  and `statement_timeout = what is left + 250 ms` once after `BEGIN` (before the draft lock) and again before the account
  debit, the only two lock waits, so the waits cannot add up past the deadline (a 5 s wait on the draft and a 5 s wait on
  the account would have been 10 s). The statement timeout sits above the lock timeout so a lock wait always ends by
  `lock_timeout` (55P03, a lock refusal) and a 57014 only means a statement that was slow for another reason or was
  cancelled, which is an error, not a refusal. `statement_timeout` is reset to 0 before `COMMIT`: a commit is never
  cancelled by the budget. If the deadline is already spent before a guarded step, the repository does not start it:
  it rolls back and refuses (`execution_in_progress` before the draft lock, `account_busy` before the account), a
  definite outcome. The pg pool adds `connectionTimeoutMillis = 2 s`. The worst case is about 6 s + 0.25 s + 1 s, so a
  call the gateway abandons at 10 s has long since rolled back or committed.
  - A lock wait on the **draft** that runs out answers `execution_in_progress` ("La transferencia se está
    procesando. Esperá unos segundos y confirmá de nuevo con tu PIN."): another call on this draft holds it.
  - A lock wait on the **source account's row** that runs out answers `account_busy` ("La cuenta de origen está
    ocupada con otra operación. Esperá unos segundos y confirmá de nuevo con tu PIN."): another transfer holds the
    account, not this draft. It comes after the token insert, which rolls back with the rest, so the token stays
    unspent.
  Both fail closed and confirming again is safe: a finished execution answers with its receipt.
- **Failures around the execution.** A failure of the step-up check or the draft read, or either running past the
  deadline, happens before anything was spent or moved: `NotExecutedError`, answered `not_executed` ("No pude
  procesar la confirmación y no se ejecutó nada. Confirmá de nuevo con tu PIN en unos segundos."). The draft stays open
  and, nothing being in flight, the bot may ask again at once. After a confirmed commit the receipt always goes out: if
  the account or beneficiary lookup fails or is slow, it goes out without those two fields (so the bot's receipt card,
  which needs them, is not shown, and the model still has the reference), and the failure is logged as a warning.
  Known residual: `createStepUpVerifier` still reads any verification failure, a JWKS fetch error included, as an
  invalid token (`not_authorised`, which closes the draft); only a hang past the 2 s bound is `not_executed`.
- **Unknown outcome.** When the execution itself throws (a driver error, a statement cancelled for another reason, a
  lost connection, a failed commit) the tool callback logs the error type and driver code, no message or values, and
  answers the generic `internal_error` ("No pude confirmar si la transferencia se realizó. Confirmá de nuevo con tu PIN
  en unos segundos: si ya se hizo, vas a recibir el mismo comprobante."), never the driver's text. A client that
  threw is released with the error, so the pool drops it. The gateway answers `upstream_error` when the backend times
  out or the call fails below the tool. In both the transaction may have committed, so the rule is the record's: the
  draft stays open, and a fresh confirmation is answered from the record (the receipt if it committed, a new execution
  if it rolled back). Nothing aborts a call at the gateway, but the deadline is below the gateway's timeout, so this is
  rare, and it never closes a draft whose money moved.
- **The grant check lives in the domain.** `grantMatchesDraft` (`transfer-rules.ts`) is bound by the use case to what
  the token authorises and passed to the repository as `isAuthorised`, which calls it with the draft row it locked: the
  rule exists once, and the in-memory and Postgres adapters cannot diverge on it.
- **mcp-payments messages.** `token_already_used`: "Esa confirmación ya se usó. Confirmá de nuevo con tu PIN." (the
  draft is open again).
- **Bot.** `CLOSING_BANK_ERRORS` in `drafts.py` lists the codes that close a draft: `draft_expired`,
  `draft_not_pending`, `draft_not_found`, `insufficient_funds` and `not_authorised`, plus a result with no error code
  (a receipt, the customer's denial or cancel, Pydantic AI's synthesized result for an interrupted call). Every other
  code leaves the draft open, whoever raised it: `token_already_used`, `execution_in_progress`, `account_busy`,
  `not_executed`, `upstream_error` and `internal_error` from the bank, the gateway's refusals that never reached it
  (`rate_limited`, `insufficient_scope`, `unknown_tool`, `service_unavailable`), the bot's own `policy_denied`, and a
  code nobody has invented yet, as does a failed result with no readable code. The list is inverted from F72's
  ("every code but these keeps it open", not the reverse) because a closed draft whose money may have moved sends the
  customer to prepare a payment twice, while an open one at worst raises one more PIN card, and the single-use
  step-up token is still required for every execution. Asking again raises a new interrupt, and the approval carries a
  fresh step-up token from the app; the bot never resends a spent one. After `execution_in_progress`, `account_busy`,
  `upstream_error` or `internal_error` the first execution may still hold the lock, so the bot raises no second
  approval for that draft **in the same run** (`held_drafts`, read from the run's messages: `PolicyToolset` refuses
  the model's repeat call as `policy_denied`, which leaves the draft open); the customer confirms again on their next
  message. `token_already_used`, `not_executed` and the gateway's refusals end the first call, so they re-prompt at
  once.
- **One `execute_transfer` per draft per model response.** Parallel calls in one model response are all checked
  before any has a result, so each would raise its own PIN card or race on the draft's lock. `PolicyToolset` lets only
  the first call for a draft in a response go on and refuses the others as `policy_denied`
  (`repeats_call_in_response`), whatever the first's result will be. Across responses the draft's results decide:
  `held_drafts` for an execution that may still run, and an at-once re-prompt after `token_already_used` is intended.

## Alternatives
- **Keep F72's behaviour** (any bank answer closes the draft, "start again"). Rejected: it tells the customer to repeat
  a payment that may have moved.
- **Claim first, in its own transaction, and link it afterwards** (or an `in_flight` status on `used_jtis`).
  Rejected: a crash between the two leaves the same ambiguity and needs a recovery sweep, where one transaction cannot
  be half done.
- **Answer every spent token on an executed draft with the receipt.** Rejected: the answer should follow what the token
  did. A token that moved nothing is told so (`draft_not_pending`), and the receipt is tied to the token that earned it
  or to a token nothing has spent.
- **`NOWAIT` and answer `execution_in_progress` at once.** Rejected: the common double click would then answer an error
  where the customer expects the receipt, and the lock is held for milliseconds.
- **An advisory lock or Redis lock per draft.** Rejected: the row lock already exists and rolls back with the
  transaction; another moving part adds nothing.

## Consequences
- **Schema change.** `data/seed/001_schema.sql` changes two tables (the seed is the schema's only home; there are no
  migrations). An existing database needs `make seed`, which drops and recreates the `bank` schema (synthetic data, and
  every step-up token lives 2 minutes, so no live `used_jtis` row is lost that matters). No in-place migration is
  provided: a `transfers` row cannot be given a real `step_up_jti` after the fact. Rebuild and restart `mcp-payments`
  with the re-seed: the old image against the new schema fails on `used_jtis.draft_id NOT NULL`, the new image against
  the old schema on the missing columns.
- **Repository port.** `claimTokenId` and `findReceipt` leave `TransfersRepository`; `executeDraft` takes the `jti`
  and the authorised grant and returns the receipt or `refused` with the wire error code itself, so there is one
  vocabulary from the repository to the tool.
- **Tests.** Repository tests run against Postgres (`TEST_DATABASE_URL`) for the races, both lock timeouts (each
  waits for a real blocked backend before releasing the holder) and the deadline; a scripted connection checks the
  transaction's plumbing (no timeout on the commit, a spent deadline refused before a guarded step, 57014 not read as a
  lock refusal, the client released with its error); the use-case tests run on an in-memory repository with the
  same contract.
- **Residual.** A rejected `insufficient_funds` attempt spends its token, and the bot closes the draft on it, so a
  customer short on balance prepares the transfer again (new draft, new PIN) after topping up; the same token is never
  sent twice anyway. The lock wait (5 s) and the call's deadline (6 s) are constants, not configuration. Only the commit can
  leave the outcome unknown to a caller, and the record answers that.
