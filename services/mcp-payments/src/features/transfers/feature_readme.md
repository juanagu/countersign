# transfers

Beneficiaries and the transfer lifecycle: prepare a draft (T2), execute it with approval and step-up (T3).

## Exposed interface

MCP tools at `POST /mcp`:

- `list_beneficiaries` (T1, scope `beneficiaries:read`).
- `prepare_transfer(source_account_id, beneficiary_id, amount, currency)` (T2, scope `transfers:prepare`):
  checks ownership of both, matching currency, the per-transfer limit and the balance; stores a
  `pending` draft that expires in 5 minutes and returns it.
  The rules live in the `prepareTransfer(repo, customerId, args, now)` use-case (`prepare-transfer.ts`),
  which returns the draft or a typed error; the tool callback only checks the scope and shapes the output.
- `execute_transfer(draft_id, step_up_token)` (T3, scope `transfers:execute` on the access token and on the
  step-up token; listed under `transfers:prepare` via `bank/listScope`, so the model sees it before approval but the
  gateway serves a call only on a token holding `transfers:execute`, which the bot gets for the approved call alone, ADR 020): `executeTransfer` verifies the step-up token (ADR 013), then
  `repo.executeDraft({ draftId, jti, isAuthorised, deadline }, now)` runs one transaction under the draft's row lock
  (ADR 023). The whole call shares one 6 s `Deadline` started in the tool callback (under the gateway's 10 s): the
  step-up check (2 s at most), the draft read, the repository (which arms `lock_timeout` and `statement_timeout` from
  what is left before its two lock waits, never on `COMMIT`, and refuses with a rollback when nothing is left) and
  the receipt lookup. Inside it the grant is checked by the domain's `grantMatchesDraft`, passed in as `isAuthorised`
  and called on the draft read under the lock (a mismatch is `not_authorised` and spends nothing), an expired draft
  answers `draft_expired` and spends nothing, and otherwise the token is spent once the draft is found pending, and the
  transfer records that `jti` (`transfers.step_up_jti`), so a replay is answered from what happened:
  the token that executed the draft gets the same receipt (a double click, a retry); a token nothing has spent
  gets the receipt of an executed draft and stays unspent; a spent token on a draft another token executed gets
  `draft_not_pending`; a spent token on a pending draft gets `token_already_used`, which therefore only ever
  means "spent, nothing moved with it, the draft is still pending", and the bot keeps the draft open for a fresh
  confirmation. A call that cannot get the draft's lock in time (another call is still executing it) rolls back,
  spends nothing and answers `execution_in_progress`; one that cannot get the source account's row (another
  transfer holds it) rolls back, token included, and answers `account_busy`. Both are safe to confirm again, which
  then returns the receipt if the first call finished. The repository returns the wire code itself (`refused`),
  so there is one error vocabulary. A failure before the execution (the step-up check or the draft read failing or
  outlasting the deadline) throws `NotExecutedError` and answers `not_executed`: nothing ran, the draft stays open. A
  failure after a confirmed commit (the account or beneficiary lookup for the receipt) still returns the receipt,
  without those fields. An error thrown inside `executeDraft` is caught in the tool callback, logged as its
  type and driver code only, and answered as the generic `internal_error`: the outcome is unknown, so the bot keeps
  the draft open. Errors: `not_authorised`, `token_already_used`, `draft_not_found`, `draft_expired`,
  `draft_not_pending`, `insufficient_funds`, `execution_in_progress`, `account_busy`, `not_executed`, `internal_error`.

## Data flow

Token the gateway exchanged (`aud=mcp-payments`, actor chain `[mcp-gateway, bot]`; any other chain is refused, ADR 017) → `Principal.sub` → `TransfersRepository` (Postgres `bank` schema).
Money is computed in integer cents and returned as two-decimal strings. An execution debits amount + fee
and writes one `transferencias` movement plus, when the fee is above zero, a `comisiones` one.
