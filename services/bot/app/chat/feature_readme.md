# chat

The orchestrator agent and its AG-UI endpoint.

## Exposed interface

- `POST /agent`: AG-UI `RunAgentInput` in, SSE events out (`AGUIAdapter.from_request` → `run_stream` wrapped by
  the guardrails' `guarded_stream` → `streaming_response`).
- `build_agent(model)`, `BotDeps(user_id, access_token, session_id, guard)`, `SYSTEM_PROMPT`.

## Data flow

Verified `Principal` → `BotDeps` (identity from the token only, a `RunGuard` per run) → Pydantic AI run on
`BOT_MODEL`, concurrent with the input classifier → events held until the verdict → text released a sentence at a
time as `TEXT_MESSAGE_CONTENT` events after the output checks. Customer turns reach the model with PII masked. The system prompt is server-owned; client-supplied
AG-UI state is ignored.
