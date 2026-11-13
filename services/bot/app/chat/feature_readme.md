# chat

The orchestrator agent and its AG-UI endpoint.

## Exposed interface

- `POST /agent`: AG-UI `RunAgentInput` in, SSE events out (`AGUIAdapter.dispatch_request`).
- `build_agent(model, skills, domain_tools, clock)`, `BotDeps(user_id, access_token)`, `SYSTEM_PROMPT`. The
  `clock` (`app.core.clock.BankClock`) gives the bank's today for the instructions and the tool policy.

## Data flow

Verified `Principal` → `BotDeps` (identity from the token only) → Pydantic AI run on `BOT_MODEL` →
text deltas as `TEXT_MESSAGE_CONTENT` events. The system prompt is server-owned; client-supplied
AG-UI state is ignored.
