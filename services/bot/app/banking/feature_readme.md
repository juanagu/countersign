# banking

The bot's connection to the MCP servers.

## Exposed interface

- `banking_toolset(exchanger, accounts_url, payments_url)`: one `MCPToolset` per server, combined.
- `TokenExchanger.token_for(subject_token, audience)`: RFC 8693 exchange at the IdP's `/token`, as client
  `bot` (HTTP Basic), cached per subject token and audience until 30 s before expiry.

## Data flow

Per run, each `MCPToolset` authenticates with `auth=` a function of the run context: the user's `aud=bot`
token from `BotDeps` is exchanged for `aud=mcp-accounts` or `aud=mcp-payments`. The incoming token is
never sent to an MCP server (tested end to end against fake servers over HTTP).
