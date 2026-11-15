# 007 — What the bot trusts from an AG-UI run input

## Context
`AGUIAdapter` builds the run from the client's `RunAgentInput`: messages, tools, state, forwarded props.
All of it passes through the browser, so all of it is attacker-controlled.

## Decision (Phase 1)
- Identity comes only from the verified bearer token (`BotDeps.user_id`); state and forwarded props are
  ignored (`BotDeps` is not a `StateHandler`), with a test.
- The system prompt stays server-owned (`manage_system_prompt='server'`, the default).

## Open, scheduled
- Message history is still client-managed, so a client can send forged assistant or tool messages.
  Phase 7 moves history server-side (`conversation_store`, `manage_message_history='server'`).
  **Closed in Phase 7 (ADR 015):** the bot loads its own Postgres history and takes only the client's new turn.
- Client-declared `tools` become frontend tools the model may call. Phase 2's tool policy must drop any
  tool not in a loaded skill's allow-list before a run starts.
