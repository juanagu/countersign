# 017 — MCP gateway: a thin Hono service on the MCP SDK, one more hop in the token-exchange chain

**Status:** accepted and built; amended by [ADR 020](020-skill-scoped-gateway-tokens.md), which removes the scope
widening below and has the gateway enforce token scopes. Tasks 1–5 (mcp-kit actor chains, IdP gateway client, the gateway service with its proxy,
rate limits, breaker and audit) landed in commits c62a544, 47b9ade and 81a9945. Task 6, the cutover, and task 7, the docs,
followed once the user approved rewording security rule 1 (see "What was built" below). `docs/PLAN.md` listed "an MCP
gateway as a separate service" as out of scope; the user asked for one, which overrides that line.

## Context
Today the bot keeps one `MCPToolset` per MCP server (`app/banking/mcp_toolsets.py`). It exchanges the customer's
`aud=bot` token for an `aud=mcp-accounts` or `aud=mcp-payments` token (ADR 008), and each server verifies its own
`aud` and `act.sub = bot` (`@poc/mcp-kit` `createJwtVerifier`). Nothing sits between the agent process and
the servers. So there is no single place for an audit log of tool calls, for per-customer rate limits across
conversations, or for knowing a backend is down. Each new server also needs a toolset in the bot.

Checked on 2026-11-14:
- **agentgateway** (Rust, Apache-2.0, v1.7.0 of 2026-10-27, active). It has JWT auth, CEL RBAC, rate limiting
  and OTel. It can exchange tokens per upstream (`backendAuth.oauthTokenExchange`, RFC 8693) and multiplex
  MCP servers. Its `mcp-multiplex` example prefixes every tool with `<target>_`.
- **IBM ContextForge** (Python, v1.1.1 of 2026-11-10). It has federation, an admin UI, its own JWT secret
  and auth model, its own database, and token-exchange code.
- **Docker MCP Gateway** (Go, pushed 2026-10-26, no GitHub releases). It runs catalog MCP servers in
  containers and injects the secrets and OAuth credentials it holds itself.
- `@modelcontextprotocol/sdk` 1.32.2, already in the repo, ships `Client` + `StreamableHTTPClientTransport`
  and the low-level `Server`. `Server` is tagged "use `McpServer` … only use `Server` for advanced use cases".
  A proxy that passes raw JSON Schemas and `_meta` through is such a case, because `McpServer.registerTool` wants zod schemas.

## Decision
- **Build `services/mcp-gateway`** (Node 22, Hono, `@poc/mcp-kit`, port **8100**). It is one MCP endpoint
  (`/mcp`, stateless, JSON responses, tools only), the same idiom as the two servers (ADR 002). It has one
  feature, `features/proxy/`, in the flat layout the MCP servers already use.
- **In scope:**
  1. One endpoint with an aggregated tool catalog, routed by tool name.
  2. Authentication: `aud=mcp-gateway`, actor `bot`.
  3. A token exchange per backend.
  4. Risk tiers passed through unchanged. A tool without a tier is dropped and its calls are refused.
  5. Per-customer, per-tier rate limits, in memory: T1 120/min, T2 20 and T3 10 per 10 min. They sit on top
     of the bot's per-conversation caps.
  6. One audit line per `tools/call`.
  7. OTel spans with `traceparent` carried on to the backends.
  8. A circuit breaker per backend, and `/health` reporting each backend.
- **Out of scope:**
  - A tool-authorization engine. Rule 2 stays enforced by the bot's `PolicyToolset`; the gateway doesn't
    repeat skill gating.
  - Repeating `mcp-payments`' step-up checks.
  - Retries of `tools/call`.
  - Resources, prompts, sampling, notifications and sessions.
  - Dynamic server registration and an admin UI.
  - Shared state across replicas (Redis rate limits).
  - mTLS.
  - Content scanning of arguments or results.
- **Tokens: a delegation chain, one audience per hop.**

  | Hop | Who asks the IdP | Subject token | Issued token |
  | --- | --- | --- | --- |
  | bot → gateway | client `bot` | `aud=bot` | `aud=mcp-gateway`, the banking scopes, `act: {sub: bot}` |
  | gateway → backend | client `mcp-gateway` (new secret) | the `aud=mcp-gateway` token | `aud=mcp-accounts` or `mcp-payments`, scopes ⊆ subject ∩ ceiling, `act: {sub: mcp-gateway, act: {sub: bot}}` |

  - The IdP holds a map per client. It records which subject audience each client may present and which
    audiences it may ask for: `bot` may ask only for `mcp-gateway`, and `mcp-gateway` only for the two backends.
    A downstream token never widens the subject's scopes and never outlives it.
  - Backends require the actor chain `[mcp-gateway, bot]`. A token the bot exchanged itself, a token sent
    straight past the gateway, and the gateway's own `aud=mcp-gateway` token are all refused.
  - The gateway caches backend tokens per inbound `jti`, `sub` and audience, until a little before they expire.
    Nothing caches across customers, and nothing is logged.

  This keeps the MCP rule that a server accepts only tokens issued for itself, at every hop. The other
  option, where the bot keeps exchanging per server and the gateway checks and forwards that token, makes
  the gateway accept and pass on tokens addressed to someone else. It also leaves the bot with one toolset per
  server, so the gateway would be a single entry point in name only.
- **Step-up (rule 3) stays end to end.** The step-up token travels as the `step_up_token` argument
  (ADR 013), `aud=mcp-payments`, with no `act`. The gateway forwards arguments byte for byte and never reads,
  checks or logs them. `mcp-payments` verifies signature, `aud`, `exp`, `jti` and the grant against its stored
  draft, as it does today. No `tools/call` is retried: a replay would spend the `jti` or create a second draft.
- **Catalog.** On `tools/list` the gateway lists every backend with that customer's backend token and merges
  the results without prefixes. Names, input schemas and `_meta` (`bank/riskTier`) are copied verbatim. A
  name served by two backends makes the gateway report unhealthy and serve neither. Unprefixed names keep every
  key the bot and the stored conversations use: skill allow-lists, `DEFAULT_ARG_CHECKS`, `TemplateToolset`,
  `THIRD_PARTY_TEXT_TOOLS`, the evals' tool-selection cases, and the tool calls in Postgres history.
- **When a backend is down.** After 5 consecutive failures (transport error, 5xx, or a 10 s timeout), its breaker opens for 30 s, then
  lets one probe call through. While it is open,
  `tools/list` serves that backend's last good schemas (they don't depend on the customer), and its calls
  return at once as an MCP tool error, `{"error": "service_unavailable", "service": "payments"}`. The bot
  already passes tool errors to the model as final answers (`tool_error_behavior="failed"`), so the model can
  say that service is down while the other still works. The bot's `unavailable_servers` now covers only the
  gateway itself.
- **Audit and telemetry (rule 7).** One pino line per call, `metric: "mcp.tool_call"`, with:
  - `sub`, the opaque customer id, never a name;
  - tool, backend, tier, outcome (`ok`, `tool_error`, `rate_limited`, `unavailable`, `upstream_error`) and
    duration;
  - the trace id.

  It never carries arguments, results, error bodies or tokens. Spans carry the same fields. `make pii-scan`
  already reads every compose service's logs.
- **Bot changes.**
  - One `SkillGatedMCPToolset` on `MCP_GATEWAY_URL`, with id `mcp-gateway` and `needed_by` `{accounts, payments}`.
  - `MCP_ACCOUNTS_URL` and `MCP_PAYMENTS_URL` are removed from the bot.
  - Tool names, the policy, the templates and the evals are unchanged.
  - `traceparent` flows on its own: bot `httpx` → gateway → backends, through mcp-kit's undici instrumentation.

## Consequences
- **Rule 1's wording changes.** Today it says the bot exchanges for "`aud` = the specific MCP server". It
  would become: the bot exchanges for `aud=mcp-gateway`, and each hop exchanges again for its downstream
  audience. No hop forwards the token it received. The intent holds: the model never holds a credential, every
  token names its one recipient, and backends see the whole delegation chain.
- **One deliberate widening (removed by ADR 020, F42).** The bot's gateway token carries every banking scope whenever the accounts or
  payments skill is loaded. Before, a run that loaded only accounts got no payments token. Several things
  bound it:
  - the token never reaches the model and lives at most 5 minutes;
  - the gateway narrows it per backend;
  - `PolicyToolset` still gates tools by skill;
  - money still needs the step-up token.

  Narrowing the scopes by loaded skill is a follow-up.
- A new single point of failure, one more hop, one more client secret (`MCP_GATEWAY_CLIENT_SECRET`), and
  two exchanges per backend per run. These are milliseconds locally. A new MCP server needs an IdP entry and a
  gateway backend entry, but no bot change.
- Rate limits and breakers live in one process, like the bot's caps (ADR 014).
- We own about 500 lines of proxy code that handle only stateless tool calls. agentgateway is the production
  direction. Before it could replace this service, a spike must confirm three things: its tool prefixing can
  be turned off, its exchange can act as client `mcp-gateway`, and its logs can be kept free of arguments.
  The contract above (one endpoint, `aud=mcp-gateway`, nested `act`, unprefixed names, `_meta` verbatim) is
  written so that it can.
- ADR 008's audiences, ceilings and "a new server needs a bot toolset" consequence are superseded where
  they conflict with this ADR.

## What was built
Beyond the decision above, the cutover (task 6) did this:
- **Rule 1** in `AGENTS.md` now reads as the Consequences section proposes: the bot exchanges for `aud=mcp-gateway`,
  each hop exchanges again, no hop forwards a token, every server rejects any `aud` but its own, and the backends
  require the actor chain `[mcp-gateway, bot]`. The architecture diagram and the ports line name the gateway.
- **Bot.** `banking_toolset(exchanger, gateway_url=...)` returns one `SkillGatedMCPToolset` (id `mcp-gateway`,
  `needed_by` `GATEWAY_NEEDED_BY` = accounts, payments). `MCP_GATEWAY_URL` replaces `MCP_ACCOUNTS_URL` and
  `MCP_PAYMENTS_URL` in the bot's settings and in its compose environment (the bot now waits for a healthy gateway
  instead of the two servers). Tool names, policy, templates and evals are untouched. `unavailable_servers` holds
  only `mcp-gateway`.
- **IdP.** Client `bot` may ask only for `aud=mcp-gateway` (`CLIENT_POLICIES`); a request for `mcp-accounts` or
  `mcp-payments` is `invalid_target`. The side-by-side window is closed.
- **Backends.** `mcp-accounts` and `mcp-payments` build their verifier from `ALLOWED_ACTOR_CHAINS`
  (`[['mcp-gateway', 'bot']]`, exported by each `app.ts`) and no longer accept `[bot]`.
- **Negative tests (rule 1).** The IdP refuses `bot` asking for either backend audience (BFF tests and the gateway's
  in-process stack). Each backend refuses a token with `act` only `bot`, the gateway's own `aud=mcp-gateway` token,
  a gateway actor alone and a chain in the wrong order (per-service `app.test.ts`, with the real constant), and
  the stack tests repeat that through real exchanges. The gateway refuses `aud=bot`, a backend-audience token, a
  wrong chain and a session token.

### Deviations
- The accepted chains are a constant in each backend, not `parseActorChains` read from config. With one accepted
  chain, a config knob would only be a way to reopen the side-by-side window, so `parseActorChains` was deleted
  from `@poc/mcp-kit`. `allowedActors` stays, for the gateway's own `[bot]`.
- `MCP_ACCOUNTS_URL` and `MCP_PAYMENTS_URL` stay in `.env.example`, relabelled as the gateway's backend URLs,
  because the gateway still reads them (compose sets them on `mcp-gateway`). The bot reads neither.
- Not a deviation, and since closed: the bot's gateway token carried every banking scope whenever the accounts or
  payments skill was loaded (the "one deliberate widening" above). ADR 020 narrowed it by skill (F42).
