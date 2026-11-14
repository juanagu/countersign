# chat

The orchestrator agent and its AG-UI endpoint.

## Exposed interface

- `POST /agent`: AG-UI `RunAgentInput` in, SSE events out (`AGUIAdapter.from_request` → `run_stream` wrapped by
  the guardrails' `guarded_stream` → `streaming_response`).
- `build_agent(model, skills, domain_tools, clock)`, `BotDeps(user_id, access_token, session_id, guard)`,
  `SYSTEM_PROMPT`. The `clock` (`app.core.clock.BankClock`) gives the bank's today for the instructions and policy.

## Data flow

Verified `Principal` → a fresh LLM run record (`app.core.llm.run_record`, before the guard and the run start) →
`BotDeps` (identity from the token only, a `RunGuard` per run) → Pydantic AI run on the orchestrator chain
(`BOT_MODEL` then `BOT_MODEL_FALLBACKS`, built in `app/core/llm/model_chain.py`, ADR 018), concurrent with the input classifier → events held until the verdict → text released a sentence at a
time as `TEXT_MESSAGE_CONTENT` events after the output checks. Customer turns reach the model with PII masked.
Client tool messages that answer an approval interrupt (`interrupt_answers.py`) are dropped before the history
loads: the `resume` entry decides the call, and the step-up token they carry never reaches the model (ADR 013). The system prompt is server-owned; client-supplied
AG-UI state is ignored.

History is server-owned (ADR 015): the adapter loads the conversation `"{user}:{threadId}"` from the
`ConversationStore` under the user's scope, takes only the client's new turn (its messages after the last assistant
response), and saves what the run added. The guard's customer messages, the third-party-text flag and the skills to
pre-load all come from that stored history, never from what the client echoes back.
