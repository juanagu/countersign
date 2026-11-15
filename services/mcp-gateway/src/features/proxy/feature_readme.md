# proxy (MCP gateway)

One MCP endpoint (`/mcp`, stateless, tools only) in front of `mcp-accounts` and `mcp-payments` (ADR 017).
It routes by tool name, exchanges tokens per backend and applies per-customer limits, a breaker per backend
and an audit line per call. It holds no banking logic and never reads, checks or logs tool arguments.

## Exposed interface

- `createProxy({ backends, exchanger, logger })` returns `buildServer(principal, context)` (for `mcpRoute`)
  and `health()`.
- `createTokenExchanger`: backend token per inbound `jti` + `sub` + audience, cached until shortly before
  expiry; one exchange is shared by concurrent calls; a failed one is forgotten.
- `Catalog`: aggregated, unprefixed tool list. `_meta` (`bank/riskTier`, `bank/scope`, `bank/listScope`) and
  schemas are copied verbatim, a tool without a tier or a valid `bank/scope` is dropped (its calls answer
  `unknown_tool`), a name two backends serve is served by neither (health: `unhealthy`).
  Each backend's last good list is kept for when it is down. `toolsFor(scopes)` filters the one shared catalog per
  request by each tool's list scope; the catalog is never filtered in place. A backend is skipped for a caller whose
  scopes list none of its tools, or whose exchange the IdP refuses with `invalid_scope`, without touching its breaker.
- `RateLimiter` (T1 120/min, T2 20 and T3 10 per 10 min, per `sub`), `CircuitBreaker` (5 failures, open 30 s,
  one probe), `createAuditLog` (`metric: "mcp.tool_call"`).

## Data flow

`tools/list` → the catalog's tools whose list scope the token holds (ADR 020).

`tools/call` → find the tool's route in the catalog (unknown: `unknown_tool`) → the route's `bank/scope` must be in
the token's scopes (else `insufficient_scope`, which is audited, never reaches the IdP or the backend and is not
counted by the rate limiter) → rate limit by token `sub` →
breaker (open: `service_unavailable` at once) → exchange the caller's `aud=mcp-gateway` token for the backend's
audience → forward name and arguments as received, with the caller's `traceparent` → return the backend's result.
No call is retried. Failures that are not the backend's fault (4xx, a tool error, a JSON-RPC answer) never trip its
breaker. Tool errors the gateway itself makes: `unknown_tool`, `insufficient_scope`, `rate_limited`, `service_unavailable`,
`upstream_error`. The backend token cache stays keyed on `jti` + `sub` + audience: each bot exchange mints a new
`jti`, so tokens for different scope sets never share a backend token.
