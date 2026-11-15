# auth

Demo sign-in against the BFF's mock IdP. The session lives in an HttpOnly cookie set by the BFF;
the browser never sees a token.

## Exposed interface

- `LoginScreen`: picks a demo user (`GET /api/auth/demo-users`) and signs in (`POST /api/auth/login`).
- `lib/auth-api.ts`: `fetchSession`, `fetchDemoUsers`, `login`, `logout`, `SessionUser`.

## Data flow

`App` calls `fetchSession` on load → signed out shows `LoginScreen` → `login` sets the cookie →
`App` renders the chat. `logout` clears the cookie and rejects unless the BFF confirmed it.
