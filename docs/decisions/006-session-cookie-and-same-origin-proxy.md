# 006 — Session in an HttpOnly cookie, browser talks only to its own origin

**Status:** accepted; the session's lifetime and logout are amended by [024](024-sliding-session-and-logout-revocation.md): it
slides (30 minutes idle, 8 hours absolute) and logout revokes the session's `sid`. The rest of this ADR stands.

## Context
The web app needs a session with the BFF's mock IdP, and the CopilotKit runtime must know the user on
every run. A bearer token held in JavaScript is readable by any script on the page.

## Decision
- `POST /auth/login` sets a `session` cookie (HttpOnly, SameSite=Strict, `Secure` via `COOKIE_SECURE`)
  holding an `aud=bff` ES256 JWT (30 min idle, 8 h absolute, with a `sid`: ADR 024). The browser never sees a token.
- The web app calls `/api/*` on its own origin. Vite's dev proxy and nginx (in Docker) forward it to the
  BFF with the prefix stripped, with buffering off so SSE streams. No CORS is configured: the BFF
  sends no `Access-Control-*` headers, and the CopilotKit runtime is mounted with `cors: false`
  (its Hono wrapper defaults to `*`).
- Every `POST` under `/auth/*` and `/copilotkit/*` must be `application/json`; anything else gets 415.
- The CopilotKit runtime uses a per-request agent factory: it re-verifies the cookie and builds an
  `HttpAgent` with a fresh `aud=bot` token (5 min, carrying the session's `sid`) for that user. The session token is never forwarded.
- The runtime's `identifyUser` returns the session's `sub`, so each CopilotKit thread belongs to the user
  who created it; another user's connect, run or stop on that thread id is refused.
- `@ag-ui/client` is pinned to the version `@copilotkit/runtime` depends on (1.0.2), because a newer
  copy makes `HttpAgent` a different type from the runtime's `AbstractAgent`.

## Consequences
CSRF is covered by SameSite=Strict plus JSON-only POSTs (a cross-site form cannot send
`application/json`, and a cross-site `fetch` that does gets no CORS grant). A BFF restart rotates the signing key and
ends every session, and logout revokes that session's `sid` (ADR 024). Bump `@ag-ui/client` together with `@copilotkit/runtime`.
