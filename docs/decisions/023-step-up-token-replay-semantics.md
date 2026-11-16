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
  does everything under it: status check, spending the token, expiry (with the clock read after the lock), debit,
  movements, the transfer. Concurrent calls on a draft serialise on that lock, so the second call of a double click
  waits for the first and then sees its result instead of racing it.
- **The record.** `used_jtis` gains `draft_id` (the draft the token was spent on), and `transfers` gains
  `step_up_jti NOT NULL UNIQUE REFERENCES used_jtis (jti)`: the token that executed the draft, and the database refuses
  a transfer without a spent token. A `used_jtis` row with no transfer naming it is, by construction, a token spent by
  an attempt that moved nothing.
- **When a token is spent.** Once the draft is locked and found `pending`, before the expiry and balance checks. A
  rejected attempt on a pending draft (`draft_expired`, `insufficient_funds`) commits its spent token, as before: the
  PIN was presented and the bank evaluated an execution. A draft that is not pending is answered from its record and
  spends nothing. A grant that does not match the stored draft (amount, currency, beneficiary, which never change, so
  the use-case checks them before the transaction) is `not_authorised` and spends nothing.
- **Answers**, in order:

| Draft state under the lock | Token | Answer |
| --- | --- | --- |
| executed | the one that executed it (`transfers.step_up_jti`) | the same receipt, no second debit |
| executed | spent elsewhere (a rejected attempt on this draft) | `draft_not_pending` |
| executed | not spent | the receipt; the token stays unspent (it can authorise nothing on a finished draft) |
| expired, cancelled or missing | any | `draft_not_pending` |
| pending | already spent | `token_already_used` |
| pending | new | spent, then executes, or `draft_expired` / `insufficient_funds` |

  The unspent-token row is ADR 013's behaviour ("a second valid token for an executed draft returns the same
  receipt"), which the failed-resume recovery depends on: the customer asks again, steps up again with a fresh token
  and gets the receipt of what already happened.
- **The invariant.** `token_already_used` means "this token was spent, nothing moved with it, and the draft is still
  pending", and nothing else.
- **In flight.** A call waits for the draft's lock for at most 5 seconds (`lock_timeout`, set per transaction; the
  gateway's backend timeout is 10 s). If it cannot get it, it rolls back, spends nothing and answers the new
  `execution_in_progress` ("La transferencia se está procesando. Esperá unos segundos y confirmá de nuevo con tu PIN."):
  fail closed, and confirming again is safe because a finished execution answers with its receipt. The same code covers
  a lock wait on the source account's row held by another transfer.
- **mcp-payments messages.** `token_already_used`: "Esa confirmación ya se usó. Confirmá de nuevo con tu PIN." (the
  draft is open again).
- **Bot.** `token_already_used` and `execution_in_progress` leave the draft open (`UNDECIDING_BANK_ERRORS` in
  `drafts.py`, beside `UNSENT_ERRORS`). Asking again raises a new interrupt, and the approval carries a fresh step-up
  token from the app; the bot never resends a spent one. For `execution_in_progress` that fresh confirmation answers
  with the receipt if the first call finished meanwhile.

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
  and returns the new outcomes `token_already_used` and `in_progress`.
- **Tests.** Repository tests run against Postgres (`TEST_DATABASE_URL`) for the races and the lock timeout; the
  use-case tests run on an in-memory repository with the same contract.
- **Residual.** A rejected attempt still spends its token, so a customer whose balance fell short confirms again with a
  fresh PIN after topping up, as before. The lock wait is a constant (5 s), not configuration.
