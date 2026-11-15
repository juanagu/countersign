# 002 — Hono for every Node service, Node images run the build stage

## Context
The BFF uses Hono by brief. The MCP servers need an HTTP host for `/health` now and the
MCP streamable HTTP transport from Phase 2. The MCP TypeScript SDK ships a Web-standard
(`Request`/`Response`) streamable HTTP transport that plugs into Hono.

## Decision
- All three Node services (`bff`, `mcp-accounts`, `mcp-payments`) use Hono on
  `@hono/node-server`, with pino for structured logs and zod-validated env config.
- Each Node image installs only its workspace slice (`pnpm install --filter <pkg>...`),
  builds with `tsc` and runs from that stage. No `pnpm deploy` pruning.
- The web image builds with Vite and is served by nginx, which also answers `/health`.

## Consequences
One HTTP idiom across Node services. Images carry dev dependencies; acceptable for a
local POC, worth pruning before any shared deployment.
