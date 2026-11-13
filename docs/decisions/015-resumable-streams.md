# 015 — Resumable streams: a Redis-backed CopilotKit runner and server-owned history

## Context
Phase 7 asks that a dropped connection mid-answer resume with no lost or duplicated text, and that a reload
restore the conversation. The plan says to evaluate CopilotKit v2 first. Measured on the live stack with runtime
1.87.0 (2026-11-13):

- The default `InMemoryAgentRunner` keeps each thread's runs in process memory (24 h owner retention) and its
  `connect` replays compacted history, then tails the live run.
- After a client disconnect mid-stream it was unreliable. A cut at 2.5 s (before any delta) replayed the full
  2,070-character answer. A cut at 5 s replayed an exact prefix of 2,017 characters with no `RUN_FINISHED`. Two
  more cuts at 5 s replayed nothing (HTTP 200 in 3 ms).
- It is process-local, so a BFF restart loses every thread. The browser client does not reconnect after a
  network drop. A reload can restore only what that process still holds in memory.

ADR 007 also left message history client-managed, so a client could forge assistant or tool turns.

## Decision
- **The runtime's pluggable runner.** The BFF passes `runner: new DurableAgentRunner(...)` to `CopilotRuntime`,
  in place of `InMemoryAgentRunner`. The runner implements `AgentRunner` (`run`, `connect`, `isRunning`, `stop`)
  plus `isThreadAccessible`, so the runtime's `identifyUser` ownership checks stay on. State lives behind a
  narrow `ThreadLog` port:
  - `RedisThreadLog` (node-redis 6.3.1) in the stack.
  - An in-memory copy for endpoint tests. Both pass the same contract suite against the compose Redis.
- **Keys** per thread `{id}`:
  - `chat:thread:{id}:events`: a Redis Stream. Entry ids are `<seq>-0`, where `seq` comes from `INCR` on
    `chat:thread:{id}:seq` inside one Lua script, so the sequence is monotonic and gap-free.
  - `chat:thread:{id}:owner`: the `identifyUser` id.
  - `chat:thread:{id}:run`: the run lease.
- **`run`:**
  1. Claims the owner (`SET NX`; another owner gets `ThreadAccessDeniedError`).
  2. Takes the lease (`SET NX PX 15s`, renewed every 5 s; a second run gets `ThreadAlreadyRunningError`).
  3. Closes any run that a dead process left open.
  4. Runs the `HttpAgent` and appends every event in order. `RUN_STARTED` carries the run input, so a replay
     has the user's message.
  5. The run belongs to the BFF process, not to the HTTP request. A client that disconnects only stops reading.
  6. `finalizeRunEvents` closes a failed or stopped run. The lease is released after the last write.
- **`connect`:**
  - A thread held by another owner yields nothing, and nobody asks the bot about it.
  - Otherwise `connect` replays every logged event (`XRANGE`), then follows live events with
    `XREAD BLOCK 5000` from the last replayed `seq`, until the run's terminal event. Replay and follow share one
    cursor, so nothing repeats and nothing is skipped.
  - If the lease lapses with the run still open, `connect` drains the log and closes the run with a `RUN_ERROR`
    (`INCOMPLETE_STREAM`).
  - CopilotKit's client resets its transcript (`MESSAGES_SNAPSHOT []`) before applying a connect, so a full
    replay leaves the answer complete and shown once.
- **Replay window:** each append resets a 15-minute TTL on the stream and the seq key. The owner is remembered
  for 24 h.
- **No `Last-Event-ID`.** CopilotKit's SSE encoder writes no `id:` field, and its client reconnects by
  `POST /agent/{id}/connect` with the thread id, not by an `EventSource` retry. `connect` replaces
  `Last-Event-ID`: the replay from `seq` 0 plus the client's reset gives the same exactly-once result, and the
  `seq` stays inside the BFF as the follow cursor.
- **Server-owned history.** The bot passes `PgConversationStore`, Pydantic AI's `ConversationStore` on Postgres
  (schema `chat`, revision-checked writes in one transaction), to `AGUIAdapter.from_request` as
  `conversation_store`.
  - `conversation_scope` is the token's user. The conversation id is `"{user}:{threadId}"`, so nobody can
    take another user's thread id first and lock its owner out.
  - The adapter loads the stored conversation, takes only the client's new turn (its messages after the last
    assistant response), and saves what a completed run added. A blocked, failed or stopped run is not saved.
  - An approval must answer a call that the stored conversation's deferred tool requests are waiting on.
  - This closes ADR 007's gap: forged assistant or tool messages never reach the model (tested).
  - The guard's customer messages, the third-party-text flag and the skills restored for a resume now read
    the stored history. `skills_loaded_in` reads `ModelMessage`s, no longer the client's JSON.
- **Restore past the window.** With no events left, `connect` asks the bot for
  `GET /threads/{id}/messages` with an `aud=bot` token minted for the thread's owner, and sends the result as
  one `RUN_STARTED` / `MESSAGES_SNAPSHOT` / `RUN_FINISHED`. The bot answers only from the caller's own
  conversation, so another user's thread id reads as empty. The transcript holds user and assistant text only.
  Tool calls are left out so the client never sees a call it might think is still pending.
- **Web.**
  - `CopilotChat` gets an explicit `threadId`, one per signed-in user in `localStorage`. The chat therefore
    connects on mount and restores the thread. Sign-out forgets the id.
  - `StreamReconnect` calls `copilotkit.connectAgent` again on `agent_run_failed` or `agent_connect_failed`.
    It backs off from 0.5 s to 8 s over five tries and waits for the `online` event when the browser is
    offline.

## Consequences
- A BFF restart keeps every thread: completed runs replay from Redis, older ones restore from Postgres. A run
  in flight dies with its BFF process, because the agent call is that process's HTTP request to the bot. The
  run's streamed text survives, and the run is closed with a `RUN_ERROR`. A BFF restart also rotates the
  session key (ADR 006), so the user signs in again before the thread comes back.
- `stop` only reaches runs in the same BFF process. That is fine for the POC's single BFF; several replicas
  would need a stop channel (Redis pub/sub).
- Past the 15-minute window, the restore loses the cards (template and A2UI activity messages), because they
  are not in the model history. A pending approval is not restorable from Postgres alone. The restored user
  text is the PII-masked text the model saw.
- Within the window, the replayed user messages come from the client's own run input (display only). The
  model's context comes only from Postgres.
- Every run's `RUN_STARTED` carries the client's message list, so the log grows with the conversation. The
  15-minute window bounds that growth.
