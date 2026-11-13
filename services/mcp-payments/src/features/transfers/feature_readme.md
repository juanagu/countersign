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
  step-up token): `executeTransfer` verifies the step-up token (ADR 013),
  claims its `jti`, checks the grant against the stored draft and executes once per draft (row lock,
  idempotent receipt). Errors: `not_authorised`, `token_already_used`, `draft_not_found`, `draft_expired`,
  `draft_not_pending`, `insufficient_funds`.

## Data flow

Exchanged token (`aud=mcp-payments`) → `Principal.sub` → `TransfersRepository` (Postgres `bank` schema).
Money is computed in integer cents and returned as two-decimal strings. An execution debits amount + fee
and writes one `transferencias` movement plus, when the fee is above zero, a `comisiones` one.
