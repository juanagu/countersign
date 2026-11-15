# banking

The bot's connection to the banking tools: one MCP endpoint, the MCP gateway (ADR 017), reached with tokens scoped
to the loaded skills.

## Exposed interface

- `banking_toolset(exchanger, gateway_url, scopes_by_skill)`: one `SkillGatedMCPToolset` on the gateway (id
  `mcp-gateway`). `scopes_by_skill` is `SkillRegistry.scopes_by_skill()`, passed in by `main.py`, so this feature
  imports nothing from `skills`. The gateway serves the accounts and payments tools merged, so the bot knows no
  backend URL. MCP `isError` results reach the model as failed tool results (`tool_error_behavior='failed'`), not
  retries.
- `TokenExchanger.token_for(subject_token, audience, scopes)`: RFC 8693 exchange at the IdP's `/token`, as client
  `bot` (HTTP Basic). `scopes` must be non-empty and is sent sorted and space-joined; a response whose `scope` isn't
  exactly that set raises `TokenExchangeError`, which carries the IdP's RFC 6749 error code (`code`) when it sent a
  known one and is logged as `oauth_error`. Not cached: each bot token is fresh per request.
- The scope `_meta` reader (`read_scope`) and `SCOPE_PATTERN` live in `policy/tool_scopes`, shared with `skills`.

## Data flow

Each agent gets its own `banking_toolset` (`main.build_agent_tree`, ADR 021): the orchestrator's with the root
skills' scopes, each subagent's with only its own, so their tokens, sessions and `jti`s are separate and never their
union. The scopes a run wants are the union of its loaded skills' `scopes`. A run that wants none (no skill, or only
`knowledge`) makes no token exchange and opens no MCP session. Otherwise the toolset exchanges the user's `aud=bot`
token for `aud=mcp-gateway` with exactly that set and opens an `MCPToolset` session with the result as static
`auth`. When a skill loaded later wants more (accounts, then payments), it exchanges for the
union, opens the new session and only then closes the old one, so a failed growth keeps the tools that worked (logged,
not marked unavailable). A run holds one session at a time. All are closed when the run ends. The incoming
token is never sent to an MCP server, and the IdP refuses client `bot` any other audience.

A tool without a valid `bank/scope` is hidden from the model and logged once per process. A call whose scope the
session holds goes through the session. A session never holds `transfers:execute`: only an approved T3 call
(`ctx.tool_call_approved`, after `PolicyToolset` checked the approval and step-up token) whose scope the session
lacks gets its own exchange for exactly that scope, and a one-call session closed right after. That token is never
reused. If that exchange or the opening of the one-call session fails (anything before `tools/call` is sent), the call answers the failed tool result
`{"error":"service_unavailable","service":"mcp-gateway"}` without a call reaching the gateway, so the step-up token stays
unspent. Any other call goes out on the session token, and the gateway refuses a scope it lacks. The MCP SDK
lists tools once per session to learn output schemas, the one-call session included.

If the session's exchange or connect fails, the run has no banking tools, is logged (error type only) and
`mcp-gateway` is added to `BotDeps.unavailable_servers`, which an instruction turns into "tell the customer it is
unavailable". One backend being down is not that case: the gateway answers its calls with a `service_unavailable`
tool error, which the model reads as a final answer.
