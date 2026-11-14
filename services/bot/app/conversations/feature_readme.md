# conversations

The bot's server-owned conversation history (ADR 015): Pydantic AI's `ConversationStore` on Postgres, and the
transcript a reload shows once the BFF's 15-minute replay window has passed.

## Exposed interface

- `PgConversationStore(pool)`: records and message entries in the `chat` schema (`ensure_schema()` at startup;
  `make seed` resets only `bank`). Writes are conditional on the stored revision, in one transaction.
- `conversation_id_for(user_id, thread_id)`, `new_turn(client_messages)`, `stored_messages(store, user, thread)`,
  `transcript(messages)` (user and assistant text plus the stored `bank-template` cards, in order; no tool calls, no A2UI surfaces).
- `GET /threads/{thread_id}/messages` (bearer `aud=bot`): `{"messages": [...]}` for the caller's own conversation
  on that thread id; anyone else's reads as empty.

## Data flow

`POST /agent` → adapter loads `"{user}:{thread}"` with `scope=user` → run on stored history + new turn → saved on
completion (a blocked, failed or stopped run is not saved). The BFF calls `GET /threads/{id}/messages` with a token
minted for the thread's owner when it has no events left to replay, and sends the result as a `MESSAGES_SNAPSHOT`.
