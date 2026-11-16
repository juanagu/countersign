# chat

Hosts the CopilotKit v2 runtime for the web chat and proxies runs to the bot over AG-UI. Threads are
resumable: every run's events go to a Redis log, so a dropped connection, a reload or a BFF restart
replays the thread instead of losing it (ADR 015).

## Exposed interface

- `chatRoutes({ issuer, revocations, cookieSecure, botAgentUrl, threadLog, logger })`: the runtime under `/copilotkit/*`, behind
  `requireSession` (which refuses a logged-out `sid` and slides the session cookie onto the streamed response, ADR 024), with no CORS headers. `identifyUser` scopes each thread to the session's user. Any path
  ending in `cpk-debug-events` (CopilotKit's cross-thread event feed) answers 404.
- Agent id: `default`.
- `runner/`: `DurableAgentRunner` (the runtime's `AgentRunner`), the `ThreadLog` port with
  `RedisThreadLog`, and `BotThreadHistory` (the bot's stored conversation, for restores past the window).

## Data flow

- `POST /copilotkit/agent/default/run` → session check → body limit (`MAX_RUN_BODY_BYTES`, 1 MiB, 413 over it:
  the runtime parses bodies with zod 3) → per-request `HttpAgent` with
  `Authorization: Bearer <aud=bot token>` → bot `POST /agent`. The runner claims the thread for the user,
  takes the run lease, and appends each event to `chat:thread:{id}:events` with a `seq` while streaming
  it back. The run continues when the client disconnects. `RUN_STARTED` carries the run input (the
  replay rebuilds user turns from its messages), minus the step-up token: the tool message CopilotKit adds
  to answer a resumed interrupt is dropped, as is any `editedArgs` or `step_up_token` key left in the input.
- `POST /copilotkit/agent/default/connect` → another user's thread gives nothing. Otherwise every logged
  event is replayed, then live events are followed from the last replayed `seq` until the run ends. With
  no events left (the 15-minute window passed), the bot's history for this user comes back as one
  `MESSAGES_SNAPSHOT` (`GET /threads/{id}/messages`, token minted for the owner in the caller's session: it is
  built from the connect request's `Authorization` header, the per-request bot token, which `BotThreadHistory` verifies
  and whose `sub` must be the owner; otherwise no history).
- Lease: a run renews it every 5 s (15 s TTL). A run whose lease lapsed without a terminal event is closed
  with a `RUN_ERROR` on replay, and in the log before the thread's next run.
