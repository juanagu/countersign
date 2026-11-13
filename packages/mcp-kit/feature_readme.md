# @poc/mcp-kit

Infrastructure shared by `mcp-accounts` and `mcp-payments`: no banking logic.

## Exposed interface

- `createJwtVerifier` / `remoteJwks`: verifies an audience-bound, exchanged access token (ES256, `iss`,
  `aud` = this server, `exp`, `sub`, `jti`, and `act.sub` in the allowed actors) into a `Principal`.
- `mcpRoute`: Hono route at `/mcp` (MCP streamable HTTP, stateless). Rejects a missing or invalid
  bearer token with 401 before any MCP handling, then builds a per-caller `McpServer`.
- `tierMeta(tier)` / `RISK_TIER_META_KEY`: risk tier in each tool's `_meta`.
- `ok`, `fail`, `requireScope`: tool result helpers.
- `@poc/mcp-kit/telemetry`: OTel bootstrap, loaded with `node --import`.

Consumers resolve the `@poc/source` export condition (TypeScript, vitest); Node runs `dist/`.
