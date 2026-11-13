# chat

Hosts the CopilotKit v2 runtime for the web chat and proxies runs to the bot over AG-UI.

## Exposed interface

- `chatRoutes({ issuer, botAgentUrl })`: the runtime under `/copilotkit/*`, behind `requireSession`,
  with no CORS headers. `identifyUser` scopes each thread to the session's user.
- Agent id: `default`.

## Data flow

`POST /copilotkit/agent/default/run` → session check → per-request `HttpAgent` with
`Authorization: Bearer <aud=bot token>` → bot `POST /agent` → AG-UI SSE streamed back to the browser.
