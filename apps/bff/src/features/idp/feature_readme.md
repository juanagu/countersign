# idp (mock identity provider)

A stand-in IdP for the POC: demo login, session cookie, and the tokens downstream services trust.
Keys are ES256, generated per process (a restart ends every session and rotates the JWKS).

## Exposed interface

- Routes: `GET /.well-known/jwks.json`, `GET /auth/demo-users`, `POST /auth/login` (`{ username }`),
  `POST /auth/logout` (revokes the session's `sid`; 204 with or without a session, 503 if the revocation could not be
  recorded), `GET /auth/me`.
- `TokenIssuer`: `issueSession` (`aud=bff`, with `sid` and `auth_time`; a second argument re-issues the same session),
  `issueBotToken` (`aud=bot`, 5 min, `sid`), `issueStepUp`, `verifySession`, `verifyBotToken`, `verifyExchangeSubject`, `jwks`.
- `RevocationStore` (`revocation-store.ts`: the interface and `MemoryRevocationStore`) and `RedisRevocationStore`.
- `requireSession(deps)` middleware, which also slides the session, and `readSession(deps, request)` (raw `Request`)
  from `session.ts`; `session-lifetime.ts` holds the 30-minute idle and 8-hour absolute constants.

## Data flow

Login sets the `session` cookie (HttpOnly, SameSite=Strict) holding the `aud=bff` JWT. Each chat run
re-verifies it and mints a fresh `aud=bot` token; the session token never leaves the BFF.

Session (ADR 024): the JWT carries `sid` (random, opaque) and `auth_time`. `requireSession` verifies it, refuses a
revoked `sid` with 401, and, with under 15 minutes of the 30 left, re-issues the cookie with the same `sid` and
`auth_time` and `exp = min(now + 30 min, auth_time + 8 h)` (nothing past the cap). Every token minted from the session
carries its `sid`, and `POST /token` copies the subject's onto what it issues. Logout writes the `sid` to the denylist
(`auth:revoked:{sid}`, TTL to the cap plus the 5-minute bot-token tail); `POST /token` answers `invalid_grant` for a
revoked subject. A session or subject token without a `sid` is refused. If the denylist cannot be read, the session
check answers 401 and the exchange `invalid_grant` (fail closed), logging `revocation_store_unavailable` without the
`sid`.
`POST /token` (RFC 8693 exchange, ADRs 008 and 017: each client in `client-policies.ts` presents one kind of
subject token and may ask for fixed audiences; `bot` → `mcp-gateway` only (it may not ask for a backend directly),
`mcp-gateway` → the two backends with scopes capped by its subject, and the `act` claim nests, so a
backend token from the gateway reads `act: {sub: mcp-gateway, act: {sub: bot}}`) and `POST /auth/step-up` (PIN → a 2-minute, single-use token
bound to one transfer draft via `authorization_details`, ADR 013) live here too.

Scopes (ADR 020): `scope` is split on spaces and deduplicated, a scope outside the allowed set (the audience's
ceiling, within the subject's for `mcp-gateway`) is `invalid_scope` and never trimmed, and a blank one is
`invalid_request`, as is a `scope` parameter sent twice (RFC 6749 §3.1). `ClientPolicy` adds two fields, set for `bot` only: `scopeRequired` (no `scope` is
`invalid_request`, so the bot never falls back to the whole ceiling) and `soloScopes` (`transfers:execute` with any
other scope is `invalid_scope`, so the token that can execute a transfer can do nothing else). The IdP does not check
that `transfers:execute` is asked for only after approval; that rests on the bot, and the step-up token is the money
lock.
A token that carries a solo scope also writes one `solo_scope_token_issued` log line (client, `sub`, audience, scope,
`jti`, `exp`; never the token).
