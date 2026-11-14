# idp (mock identity provider)

A stand-in IdP for the POC: demo login, session cookie, and the tokens downstream services trust.
Keys are ES256, generated per process (a restart ends every session and rotates the JWKS).

## Exposed interface

- Routes: `GET /.well-known/jwks.json`, `GET /auth/demo-users`, `POST /auth/login` (`{ username }`),
  `POST /auth/logout`, `GET /auth/me`.
- `TokenIssuer`: `issueSession` (`aud=bff`, 30 min), `issueBotToken` (`aud=bot`, 5 min), `verifySession`, `verifyExchangeSubject`, `jwks`.
- `requireSession` middleware and `readSession` (raw `Request`) from `session.ts`.

## Data flow

Login sets the `session` cookie (HttpOnly, SameSite=Strict) holding the `aud=bff` JWT. Each chat run
re-verifies it and mints a fresh `aud=bot` token; the session token never leaves the BFF.
`POST /token` (RFC 8693 exchange, ADRs 008 and 017: each client in `client-policies.ts` presents one kind of
subject token and may ask for fixed audiences; `bot` → `mcp-accounts`/`mcp-payments`/`mcp-gateway`,
`mcp-gateway` → the two backends with scopes capped by its subject, and the `act` claim nests, so a
backend token from the gateway reads `act: {sub: mcp-gateway, act: {sub: bot}}`) and `POST /auth/step-up` (PIN → a 2-minute, single-use token
bound to one transfer draft via `authorization_details`, ADR 013) live here too.
