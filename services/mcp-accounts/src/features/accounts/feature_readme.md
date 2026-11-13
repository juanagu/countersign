# accounts

Read-only (T1) MCP tools over the customer's accounts and transactions.

## Exposed interface

MCP tools at `POST /mcp`, each requiring scope `accounts:read` and declaring `bank/riskTier: T1`:
`list_accounts`, `get_balance(account_id)`, `list_transactions(account_id?, from?, to?, category?, limit≤100)`,
`spending_summary(from, to, account_id?)`.

## Data flow

Exchanged token (`aud=mcp-accounts`) → `Principal.sub` → `AccountsRepository` (Postgres `bank` schema).
Every lookup is scoped to `sub`; another customer's account id answers `account_not_found`, the same as
a missing one. Account numbers are masked to the last four digits.
Periods (`from`, `to`) are whole days in the bank's time zone (`BANK_TIMEZONE`, the same one the bot uses for
"today"), both inclusive, and `bookedAt` comes back as ISO 8601 with that zone's offset.
