# chat

The orchestrator agent and its AG-UI endpoint.

## Exposed interface

- `POST /agent`: AG-UI `RunAgentInput` in, SSE events out (`AGUIAdapter.dispatch_request`).
- `build_agent(model)`, `BotDeps(user_id, access_token)`, `SYSTEM_PROMPT`.

## Data flow

Verified `Principal` → `BotDeps` (identity from the token only) → Pydantic AI run on `BOT_MODEL` →
text deltas as `TEXT_MESSAGE_CONTENT` events. The system prompt is server-owned; client-supplied
AG-UI state is ignored.
