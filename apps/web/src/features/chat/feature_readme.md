# chat

The conversation screen: CopilotKit v2's `CopilotChat` against the BFF runtime at `/api/copilotkit`.
The session cookie authenticates every runtime call; the BFF turns it into a bot token.

## Exposed interface

- `ChatScreen` (`user`, `onSignOut`).

## Data flow

`CopilotChat` → `POST /api/copilotkit/agent/default/run` (SSE) → BFF → bot AG-UI endpoint.
Text deltas render as they arrive.
