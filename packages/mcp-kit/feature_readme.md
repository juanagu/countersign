# @poc/mcp-kit

Infrastructure shared by `mcp-accounts`, `mcp-payments` and `mcp-gateway`: no banking logic.

## Exposed interface

- `createJwtVerifier` / `remoteJwks`: verifies an audience-bound, exchanged access token (ES256, `iss`,
  `aud` = this server, `exp`, `sub`, `jti`, and the nested `act` chain) into a `Principal` (`actors` holds the
  chain, outermost first). `allowedActors: ['bot']` accepts the chain `[bot]` (the gateway's); `allowedActorChains`
  (the backends use `[['mcp-gateway', 'bot']]`) accepts whole chains, compared exactly (ADR 017).
- `mcpRoute`: Hono route at `/mcp` (MCP streamable HTTP, stateless). Rejects a missing or invalid
  bearer token with 401 before any MCP handling, then builds a per-caller server (`McpServer` or the
  low-level `Server`); `buildServer` also receives the verified token and the caller's `traceparent`.
- `tierMeta(tier)` / `readTier(meta)` / `RISK_TIER_META_KEY`: risk tier in each tool's `_meta`.
- `ok`, `fail`, `requireScope`: tool result helpers.
- `@poc/mcp-kit/telemetry`: OTel bootstrap, loaded with `node --import`.

Consumers resolve the `@poc/source` export condition (TypeScript, vitest); Node runs `dist/`.
