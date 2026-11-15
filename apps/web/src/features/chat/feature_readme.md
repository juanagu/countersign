# chat

The conversation screen: CopilotKit v2's `CopilotChat` against the BFF runtime at `/api/copilotkit`.
The session cookie authenticates every runtime call; the BFF turns it into a bot token.

## Exposed interface

- `ChatScreen` (`user`, `onSignOut` returning a promise that rejects when logout failed, which shows an
  alert and keeps the chat, and `onRuntimeRequestFailed`).

## Screen

`ChatHeader` (brand mark, "Nueva conversación", avatar, "Salir"), then CopilotKit's chat in a 42rem column.
`ChatView` (the `chatView` slot) re-enables CopilotKit's welcome screen, which it hides whenever a `threadId`
is given; `WelcomeScreen` renders the greeting by first name and six tiles, each sending a real message through
`useChatActions().sendMessage`, with the composer docked below. `TypingIndicator` replaces the pulsing cursor.
The message rhythm and the composer are CSS over CopilotKit's DOM (`chat-messages.css`, `chat-composer.css`):
CopilotKit's palette variables are mapped to our tokens in `chat-screen.css`, so the chat follows the OS theme
(`styles/color-scheme.ts` mirrors it onto `.dark`). Those selectors target CopilotKit's `data-testid`s.
Assistant markdown (Streamdown) gets an `img` component (`assistant-markdown.tsx`) that renders only images from
the app's own origin (`lib/image-policy.ts`); any other image, data and blob URLs included, renders nothing, so a
model-written image URL is never fetched (ADR 014).

Status the chat shows without a message: `ConnectionPill` (`connection-pill.tsx`, the `input` slot of `ChatView`)
centred above the composer from the reconnector's state (`lib/connection-status.ts`: `idle`, `waiting-online` →
"Sin conexión. Reintentamos al reconectar.", `retrying` → "Reconectando…"); `ToolStatus` (`useRenderTool('*')`,
labels in `lib/tool-labels.ts`: a spinner and a fixed phrase while a bot-side tool runs, nothing for unlisted
tools, never arguments or results); `RunErrorNotice`, an inline "No pudimos responder tu consulta." with
Reintentar in CopilotKit's interrupt slot at the end of the thread after a failed run (a failed approval resume
is reported on the confirm card instead).

## Data flow

`CopilotChat` → `POST /api/copilotkit/agent/default/run` (SSE) → BFF → bot AG-UI endpoint.
Text deltas render as they arrive.

Threads are resumable (ADR 015). `CopilotChat` gets an explicit `threadId`, one per signed-in user, kept in
`localStorage` (`chat.thread.<userId>`, `lib/thread-id.ts`), so on mount it calls the BFF's `connect`, which
replays the thread from Redis within 15 minutes or restores it from the bot's history after that. Sign-out
forgets the id, so the next sign-in starts a fresh thread; "Nueva conversación" does the same and swaps in a new
id at once (`startNewThread`). `StreamReconnect` (inside the provider) listens for
`agent_run_failed` / `agent_connect_failed`, the way a dropped stream surfaces, and calls `connectAgent` again
with backoff (0.5–8 s, five tries), waiting for the browser's `online` event when offline
(`lib/reconnector.ts`). After the fifth it waits for the next break or `online` event and starts over. CopilotKit resets the transcript before applying a replay, so the resumed answer
appears once, complete. A failed runtime request (how an expired session's 401 surfaces)
calls `onRuntimeRequestFailed`; `App` re-checks `/api/auth/me` and shows the login screen on a 401.
