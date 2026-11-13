# idp (mock identity provider)

A stand-in IdP for the POC: demo login, session cookie, and the tokens downstream services trust.
Keys are ES256, generated per process (a restart ends every session and rotates the JWKS).

## Exposed interface

- Routes: `GET /.well-known/jwks.json`, `GET /auth/demo-users`, `POST /auth/login` (`{ username }`),
  `POST /auth/logout`, `GET /auth/me`.
- `TokenIssuer`: `issueSession` (`aud=bff`, 30 min), `issueBotToken` (`aud=bot`, 5 min), `verifySession`, `jwks`.
- `requireSession` middleware and `readSession` (raw `Request`) from `session.ts`.

## Data flow

Login sets the `session` cookie (HttpOnly, SameSite=Strict) holding the `aud=bff` JWT. Each chat run
re-verifies it and mints a fresh `aud=bot` token; the session token never leaves the BFF.
Token exchange (`/token`, Phase 2) and step-up (`/auth/step-up`, Phase 5) land here.
