# 006 — Session in an HttpOnly cookie, browser talks only to its own origin

## Context
The web app needs a session with the BFF's mock IdP, and the CopilotKit runtime must know the user on
every run. A bearer token held in JavaScript is readable by any script on the page.

## Decision
- `POST /auth/login` sets a `session` cookie (HttpOnly, SameSite=Strict, `Secure` via `COOKIE_SECURE`)
  holding an `aud=bff` ES256 JWT (30 min). The browser never sees a token.
- The web app calls `/api/*` on its own origin. Vite's dev proxy and nginx (in Docker) forward it to the
  BFF with the prefix stripped, with buffering off so SSE streams. No CORS is configured.
- The CopilotKit runtime uses a per-request agent factory: it re-verifies the cookie and builds an
  `HttpAgent` with a fresh `aud=bot` token (5 min) for that user. The session token is never forwarded.
- `@ag-ui/client` is pinned to the version `@copilotkit/runtime` depends on (1.0.2), because a newer
  copy makes `HttpAgent` a different type from the runtime's `AbstractAgent`.

## Consequences
CSRF is covered by SameSite=Strict plus JSON-only endpoints. A BFF restart rotates the signing key and
ends every session. Bump `@ag-ui/client` together with `@copilotkit/runtime`.
