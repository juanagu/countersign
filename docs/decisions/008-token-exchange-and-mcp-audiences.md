# 008 — Token exchange shape and MCP audiences

## Context
Security rule 1: the bot exchanges the user's `aud=bot` token at the mock IdP for a token bound to one
MCP server with only the scopes it needs. The audience value must be the same in Docker and on a bare
local run, where the servers' URLs differ.

## Decision
- Audiences are logical names, `mcp-accounts` and `mcp-payments`, sent as the RFC 8693 `audience`
  parameter (not `resource` URLs).
- `POST /token` accepts `application/x-www-form-urlencoded` only and requires the confidential client
  `bot` (HTTP Basic, `BOT_CLIENT_SECRET`). The subject token must verify as `aud=bot`; a session token
  (`aud=bff`) is refused.
- Each audience has a ceiling: `mcp-accounts` gets `accounts:read`; `mcp-payments` gets
  `beneficiaries:read transfers:prepare`. A request may narrow it, never widen it. Executing a transfer
  is not a scope at all: it needs the Phase 5 step-up token.
- Issued tokens carry `act: {sub: "bot"}` and expire at the earlier of 5 minutes and the subject's `exp`.
- MCP servers verify issuer, their own `aud`, `exp`, `sub`, `jti`, and that `act.sub` is an allowed actor,
  so a token minted directly for a user (no exchange) is also refused. Each tool checks its scope.

## Consequences
Rotating `BOT_CLIENT_SECRET` needs the BFF and bot restarted together. A new MCP server needs an entry in
`AUDIENCE_SCOPES` (BFF) and a toolset in the bot.
