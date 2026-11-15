# conversations

The bot's server-owned conversation history (ADR 015): Pydantic AI's `ConversationStore` on Postgres, and the
transcript a reload shows once the BFF's 15-minute replay window has passed.

## Exposed interface

- `PgConversationStore(pool)`: records and message entries in the `chat` schema (`ensure_schema()` at startup;
  `make seed` resets only `bank`). Writes are conditional on the stored revision, in one transaction.
- `RunConversationStore(store, refusal)`: the store one run saves through. Its `save` awaits `refusal()` (the
  reply the customer got instead of the answer, or `None`); a refused run is saved as its turn plus that
  refusal, without the model's output, whether it completed before or after the verdict.
- `conversation_id_for(user_id, thread_id)`, `new_turn(client_messages, awaiting_results)` (drops client tool
  results the conversation awaits none for), `load_thread(store, user, thread)` / `stored_messages(...)`,
  `transcript(messages, clock=, delegates=)` (user and assistant text plus the stored `bank-template` cards, in order;
  answers re-run the output guard's PII and grounding checks through `guardrails.history_guard.StoredAnswers`,
  on the bank's day in `clock`'s zone; no tool calls, no A2UI surfaces).
- `GET /threads/{thread_id}/messages` (bearer `aud=bot`): `{"messages": [...]}` for the caller's own conversation
  on that thread id; anyone else's reads as empty.

## Data flow

`POST /agent` → adapter loads `"{user}:{thread}"` with `scope=user` → run on stored history + new turn → saved on
completion through `RunConversationStore` (a failed or stopped run, or one the block cancelled first, is not
saved; a blocked run that completed is saved as the customer's turn plus the refusal). The BFF calls `GET /threads/{id}/messages` with a token
minted for the thread's owner when it has no events left to replay, and sends the result as a `MESSAGES_SNAPSHOT`.
