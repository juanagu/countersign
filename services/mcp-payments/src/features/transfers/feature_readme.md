# transfers

Beneficiaries and the transfer lifecycle: prepare a draft (T2), execute it with approval and step-up (T3).

## Exposed interface

MCP tools at `POST /mcp`:
- `list_beneficiaries` (T1, scope `beneficiaries:read`).
- `prepare_transfer(source_account_id, beneficiary_id, amount, currency)` (T2, scope `transfers:prepare`):
  checks ownership of both, matching currency, the per-transfer limit and the balance; stores a
  `pending` draft that expires in 5 minutes and returns it.
- `execute_transfer(draft_id, step_up_token)` (T3): returns `not_authorised` until Phase 5 adds step-up
  verification.

## Data flow

Exchanged token (`aud=mcp-payments`) → `Principal.sub` → `TransfersRepository` (Postgres `bank` schema).
Money is computed in integer cents and returned as two-decimal strings.
