# chat

Hosts the CopilotKit v2 runtime for the web chat and proxies runs to the bot over AG-UI. Threads are
resumable: every run's events go to a Redis log, so a dropped connection, a reload or a BFF restart
replays the thread instead of losing it (ADR 015).

## Exposed interface

- `chatRoutes({ issuer, botAgentUrl, threadLog, logger })`: the runtime under `/copilotkit/*`, behind
  `requireSession`, with no CORS headers. `identifyUser` scopes each thread to the session's user.
- Agent id: `default`.
- `runner/`: `DurableAgentRunner` (the runtime's `AgentRunner`), the `ThreadLog` port with
  `RedisThreadLog`, and `BotThreadHistory` (the bot's stored conversation, for restores past the window).

## Data flow

- `POST /copilotkit/agent/default/run` → session check → per-request `HttpAgent` with
  `Authorization: Bearer <aud=bot token>` → bot `POST /agent`. The runner claims the thread for the user,
  takes the run lease, and appends each event to `chat:thread:{id}:events` with a `seq` while streaming
  it back. The run continues when the client disconnects. `RUN_STARTED` carries the run input (the
  replay rebuilds user turns from its messages), minus a resume's `editedArgs`, which hold the step-up token.
- `POST /copilotkit/agent/default/connect` → another user's thread gives nothing. Otherwise every logged
  event is replayed, then live events are followed from the last replayed `seq` until the run ends. With
  no events left (the 15-minute window passed), the bot's history for this user comes back as one
  `MESSAGES_SNAPSHOT` (`GET /threads/{id}/messages`, token minted for the owner).
- Lease: a run renews it every 5 s (15 s TTL). A run whose lease lapsed without a terminal event is closed
  with a `RUN_ERROR` on replay, and in the log before the thread's next run.
