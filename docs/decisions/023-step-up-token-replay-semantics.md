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
- **One transaction, one lock.** `executeDraft({ draftId, customerId, jti, isAuthorised, deadline }, now)` takes the
  draft's row lock (`FOR UPDATE`) first, with no read of the draft before it, and does everything under it: the
  ownership check, the grant check, the status check, expiry (with the clock read after the lock), spending the token,
  debit, movements, the transfer. A draft that is missing or belongs to another customer answers `draft_not_found`,
  checked on the row the lock returns. Concurrent calls on a draft serialise on that lock, so the second call of a double click
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
  that is not pending is answered from its record and spends nothing. Only an execution and `insufficient_funds`
  commit, since only they wrote something; every other refusal rolls back and answers its own code, so the commit's
  deadline check cannot turn a definite refusal into `not_executed`.
- **The grant.** The step-up token authorises an amount, currency and beneficiary. The repository compares them with
  the draft row it reads under the lock, so the check does not depend on those fields never changing, and a mismatch
  is `not_authorised` and spends nothing, whatever the draft's status.
- **Answers**, in order:

| Draft state under the lock | Token | Answer |
| --- | --- | --- |
| executed | the one that executed it (`transfers.step_up_jti`) | the same receipt, no second debit |
| executed | spent elsewhere (a rejected attempt on this draft) | `draft_not_pending` |
| executed | not spent | the receipt; the token stays unspent (it can authorise nothing on a finished draft) |
| missing, or another customer's | any | `draft_not_found` |
| expired or cancelled | any | `draft_not_pending` |
| pending, past its expiry | any | `draft_expired`, nothing spent |
| pending | already spent | `token_already_used` |
| pending | new | spent, then executes, or `insufficient_funds` |

  The unspent-token row is ADR 013's behaviour ("a second valid token for an executed draft returns the same
  receipt"), which the failed-resume recovery depends on: the customer asks again, steps up again with a fresh token
  and gets the receipt of what already happened.
- **The invariant.** `token_already_used` means "this token was spent, nothing moved with it, and the draft is still
  pending", and nothing else.
- **The receipt comes from the transaction.** The receipt card needs the source account's alias and number and the
  beneficiary's name, bank and account, and the money has already moved by the time anyone could look them up, so no
  lookup exists after the commit. The locking read joins the draft to its account and beneficiary (`FOR UPDATE OF` the
  draft, so only the draft is locked), and the fresh execution and the replay both build the receipt from that row and
  the transfer's own row: amount, fee and currency from the draft, reference and time from the transfer. A fresh run
  and a replay therefore answer the same receipt, whole, whatever the database does next, and the bot's receipt
  card (security rule 4) is never starved of a field.
- **One deadline, checked before every statement.** The deadline starts once, at the top of the `execute_transfer`
  callback (`Deadline`, 6 s, a required parameter below it) and every step shares it: the step-up check (2 s of it at
  most, since a cold JWKS cache fetches the IdP's keys), the pool's `connect()` (raced against what is left), and each
  statement of the transaction. Before every statement the repository reads what is left; with nothing left it rolls
  back and answers `not_executed`, since nothing was committed. Otherwise it sets `statement_timeout` to what is left
  and `lock_timeout` to the lesser of 5 s and what is left (a `set_config` round trip per statement: the waits of one
  call cannot add up past the deadline, which one `SET` after `BEGIN` could not promise). The commit gets no statement
  timeout (it is reset first): cancelling it would leave the outcome unknown for a transaction that was fine. The
  pg pool has no `connectionTimeoutMillis` of its own, so the other tools queue for a connection as before. A cancel
  that fires because the deadline ran out (`55P03` or `57014` with nothing left) is `not_executed`, except a lock
  wait on the **draft**, which is `execution_in_progress` even when the deadline has also run out: another call holds
  the draft. A lock wait on the account that ends at its own 5 s limit with time left is a real wait on a row
  another call holds:
  - on the **draft**: `execution_in_progress` ("La transferencia se está procesando. Esperá unos segundos y confirmá
    de nuevo con tu PIN.");
  - on the **source account's row**: `account_busy` ("La cuenta de origen está ocupada con otra operación. Esperá unos
    segundos y confirmá de nuevo con tu PIN."), which comes after the token insert and rolls it back, so the token
    stays unspent. Nothing is in flight for the draft, so it stays open and the bot does not hold it.
  Both fail closed and confirming again is safe: a finished execution answers with its receipt.
- **`not_executed`: every path where nothing ran.** The deadline spent before the transaction, a pool that gives no
  connection in time (or fails to give one: nothing was sent), the deadline running out before or during a statement
  of the transaction (rolled back, never committed), and a step-up check that could not be made: a JWKS fetch error or
  timeout, or any failure that is not jose's verdict on the token. A bad signature, an expired token, a wrong
  audience or issuer, an unknown key id and malformed claims stay `not_authorised`, which closes the draft; the
  verifier tells the two apart by jose's error classes and rejects for everything else. `not_executed` ("No pude
  procesar la confirmación y no se ejecutó nada. Confirmá de nuevo con tu PIN en unos segundos.") leaves the draft
  open, is not held, and the bot may ask again at once, because nothing is in flight.
- **Unknown outcome.** When the execution itself throws after something may have been sent (a driver error, a statement
  cancelled with time still left, a lost connection, a failed commit) the tool callback logs the error type and driver code, no message or values, and
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
  fresh step-up token from the app; the bot never resends a spent one. After `execution_in_progress`,
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
- **Repository port.** `claimTokenId`, `findReceipt` and `findDraft` leave `TransfersRepository`; `executeDraft`
  takes the caller, the `jti`, the grant check and the deadline, and returns the receipt (whole) or `refused` with the
  wire error code itself, so there is one vocabulary from the repository to the tool. The use case has no failure to
  signal besides a result: `not_executed` is an answer, not an exception.
- **Tests.** Repository tests run against Postgres (`TEST_DATABASE_URL`) for the races, both lock timeouts (each
  waits for a real blocked backend before releasing the holder), the deadline, the whole receipt on a fresh run and a
  replay, ownership and a starved pool; a scripted connection checks the transaction's plumbing (every statement armed
  from what is left and none started with nothing left, several slow statements stopping at the budget, no timeout on
  the commit, a pool that gives no connection, 57014 with time left not read as a lock refusal, the client released
  with its error); a contract test reads the receipt fields `TransferReceiptData` requires from the schema; the use-case tests run on an in-memory repository with the
  same contract.
- **Residual.** A rejected `insufficient_funds` attempt spends its token, and the bot closes the draft on it, so a
  customer short on balance prepares the transfer again (new draft, new PIN) after topping up; the same token is never
  sent twice anyway. The lock wait (5 s) and the call's deadline (6 s) are constants, not configuration. After the commit is sent
  the outcome can be unknown to a caller, and the record answers that. A `not_executed` is logged without its cause (the
  use case and the repository answer with a code only), so a database that stays down shows as a run of those warnings.
