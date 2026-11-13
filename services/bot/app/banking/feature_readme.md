# banking

The bot's connection to the MCP servers.

## Exposed interface

- `banking_toolset(exchanger, accounts_url, payments_url)`: one `SkillGatedMCPToolset` per server, combined.
  Each wraps an `MCPToolset` and connects only once a loaded skill needs that server (`SKILLS_BY_AUDIENCE`).
  MCP `isError` results reach the model as failed tool results (`tool_error_behavior='failed'`), not retries.
- `TokenExchanger.token_for(subject_token, audience)`: RFC 8693 exchange at the IdP's `/token`, as client
  `bot` (HTTP Basic), cached per subject token and audience until 30 s before expiry.

## Data flow

A run that loads no banking skill makes no token exchange and opens no MCP session. Once a skill needs a
server, its `MCPToolset` connects for the rest of the run, closed when the run ends. It authenticates with
`auth=` a function of the run context: the user's `aud=bot` token from `BotDeps` is exchanged for
`aud=mcp-accounts` or `aud=mcp-payments`. The incoming token is never sent to an MCP server (tested end to end against fake servers over HTTP).
