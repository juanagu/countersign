# chat

The conversation screen: CopilotKit v2's `CopilotChat` against the BFF runtime at `/api/copilotkit`.
The session cookie authenticates every runtime call; the BFF turns it into a bot token.

## Exposed interface

- `ChatScreen` (`user`, `onSignOut` returning a promise that rejects when logout failed, which shows an
  alert and keeps the chat, and `onRuntimeRequestFailed`).

## Data flow

`CopilotChat` → `POST /api/copilotkit/agent/default/run` (SSE) → BFF → bot AG-UI endpoint.
Text deltas render as they arrive. A failed runtime request (how an expired session's 401 surfaces)
calls `onRuntimeRequestFailed`; `App` re-checks `/api/auth/me` and shows the login screen on a 401.
