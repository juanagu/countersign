# 009 — Both MCP servers read the one mock bank database; shared code in `@poc/mcp-kit`

## Context
The standards give each service its own database. The brief draws both MCP servers on one Postgres with
the mock bank data, and `prepare_transfer` needs the source account's balance.

## Decision
- `mcp-accounts` and `mcp-payments` both use the `bank` schema seeded by `make seed`. Payments reads
  `accounts` (balance, currency, owner) and owns `beneficiaries`, `transfer_drafts`, `transfers`, `used_jtis`.
- Infrastructure both servers need (token verification, the authenticated MCP route, tier metadata, tool
  result helpers, telemetry, test token minting) lives in `packages/mcp-kit`. No banking logic goes there.
- Workspace packages export their TypeScript source under the custom condition `@poc/source` (used by
  `tsc` and vitest) and `dist/` by default (used by Node). The generic name `source` collided with a
  third-party package that exports raw `.ts` under it.

## Consequences
A schema change in `accounts` can break payments; acceptable for a POC with one seed file. A real system
would split the data and have payments ask accounts for the balance.
