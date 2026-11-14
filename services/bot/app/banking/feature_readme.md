# banking

The bot's connection to the banking tools: one MCP endpoint, the MCP gateway (ADR 017).

## Exposed interface

- `banking_toolset(exchanger, gateway_url)`: one `SkillGatedMCPToolset` on the gateway (id `mcp-gateway`). It wraps
  an `MCPToolset` and connects only once a loaded skill needs it (`GATEWAY_NEEDED_BY`: accounts, payments). The
  gateway serves the accounts and payments tools merged, so the bot knows no backend URL.
  MCP `isError` results reach the model as failed tool results (`tool_error_behavior='failed'`), not retries.
- `TokenExchanger.token_for(subject_token, audience)`: RFC 8693 exchange at the IdP's `/token`, as client
  `bot` (HTTP Basic). Not cached: each bot token is fresh per request and each run exchanges once, for the gateway.

## Data flow

A run that loads no banking skill makes no token exchange and opens no MCP session. Once a skill needs the
gateway, its `MCPToolset` connects for the rest of the run, closed when the run ends. If the exchange or the
connect fails, the run has no banking tools, is logged (error type only) and `mcp-gateway` is added
to `BotDeps.unavailable_servers`, which an instruction turns into "tell the customer it is unavailable". One
backend being down is not that case: the gateway answers its calls with a `service_unavailable` tool error, which the
model reads as a final answer. The toolset authenticates with `auth=` a function of the run context: the user's
`aud=bot` token from `BotDeps` is exchanged for `aud=mcp-gateway`, and the gateway exchanges again for each backend.
The incoming token is never sent to an MCP server, and the IdP refuses client `bot` any other audience (tested end
to end against a fake gateway over HTTP).
