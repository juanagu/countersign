# 024 — Sliding session and logout revocation by `sid`

**Status:** accepted (backlog F82 and F83; covers F2 and the logout item of F56). Amends
[ADR 006](006-session-cookie-and-same-origin-proxy.md): its fixed 30-minute session is replaced by the decision below.
The cookie's attributes, the same-origin proxy and the CSRF reasoning in 006 stand.

## Context
- The session was a fixed 30-minute JWT cookie, so an active customer was signed out in the middle of a conversation.
- Logout only deleted the cookie. The JWT stayed valid until `exp`, and every token minted from it (the `aud=bot` token,
  the step-up token, the gateway and backend tokens of ADR 008 and 017) could still be minted and exchanged, including
  by a bot run that was already in progress.

## Decision
**Sliding session.**
- The session JWT carries `sid` (24 random bytes, base64url, opaque) and `auth_time` (login time, seconds). Both stay
  the same across every re-issue of that session.
- Idle lifetime 30 minutes; absolute lifetime 8 hours from `auth_time`. The constants live in
  `apps/bff/src/features/idp/session-lifetime.ts`, not in env: they are policy, and tests read them from there.
- An authenticated request that finds less than half the idle lifetime left (under 15 minutes) re-issues the cookie:
  same `sid` and `auth_time`, `exp = min(now + 30 min, auth_time + 8 h)`. Once `exp` already equals the cap there is
  nothing to extend, so nothing is re-issued and the session ends at the cap. `verifySession` also refuses a token whose
  `auth_time` is past the cap whatever its `exp`.
- `requireSession` does the re-issue, so every route behind it slides: `/auth/me`, step-up and the whole
  `/copilotkit/*` mount. The cookie is attached to the response the route returns, before a byte of a streamed body is
  read, so a long SSE run still carries it. It is never re-issued for a request that failed authentication.

**`sid` on everything minted from a session.** The bot token, the step-up token, the history-restore token and every
exchanged token (gateway and backends) carry the session's `sid`. The exchange copies the subject's `sid` onto what it
issues. The bot, the gateway and the MCP servers never read it: they verify what they always did and ignore the claim.
A session token or an exchange subject without a `sid` is refused (`401` at the session check, `invalid_grant` at
`/token`); nothing in production issues one.

**History restore.** The connect request carries, in the headers the runtime forwards, the per-request `aud=bot` token
the BFF minted from the verified session. `BotThreadHistory` verifies it, requires its `sub` to be the thread's owner,
and mints the restore token with its `sid`. A missing, foreign or `sid`-less caller token gets an empty history and no
call to the bot.

**Revocation.**
- `POST /auth/logout` verifies the cookie (signature and lifetime, not revocation), records its `sid` as revoked, then
  deletes the cookie. Without a valid session it only deletes the cookie and answers 204.
- The denylist is the `RevocationStore` interface with a Redis implementation (`auth:revoked:{sid}`, value `1`, the
  Redis instance of ADR 015) and an in-memory double. The TTL is the time left to the 8-hour cap plus 5 minutes, the
  lifetime of an `aud=bot` token, because a token minted from the session just before the cap could be presented for
  exchange that long after it.
- Checks: `requireSession`, and the `identifyUser` and per-request agent callbacks of the CopilotKit runtime, refuse a
  revoked `sid` with 401; `/token` refuses a subject whose `sid` is revoked with `invalid_grant`, at both hops (bot to
  gateway, gateway to backend). A bot run already under way when the customer logs out therefore keeps only the tokens it
  already holds, each at most 5 minutes, and can mint none.
- **Fail closed.** If the store cannot answer, the session check answers 401 and the exchange `invalid_grant`, and each
  logs one structured line (`event: revocation_store_unavailable`, `check: session | exchange | logout`, the error
  message; never the `sid` or the cookie). The Redis implementation gives every command a 1-second deadline, because
  node-redis queues commands while disconnected and a hung request is not a refusal. A logout the store could not record
  answers 503 with the cookie still cleared, so the caller does not believe a live session is gone.

## Consequences
- A Redis outage signs every customer out of the chat (401 on every authenticated request) until it returns. That is the
  price of refusing to guess; the thread log already depends on the same Redis, so the chat was down in that case anyway.
- Each authenticated chat request does up to three denylist lookups (middleware, agent factory, `identifyUser`), a
  `GET`-class command each. F1 (resolve the session once per request) would cut that to one. A revocation landing between
  the lookups surfaces as a 500 from the runtime instead of a 401, the same shape as the expiry case F1 already records.
- A token already minted is not recalled: a bot token lives up to 5 minutes after logout and the bot accepts it, a gateway
  token likewise at the gateway and backends. Revocation stops the mint, not what exists. Shortening those lifetimes
  or introspecting at the gateway is the production step.
- A BFF restart still rotates the signing key and ends every session (ADR 006), so the denylist only has to cover the
  life of one key; it is kept in Redis anyway so that several BFF replicas would agree.
- Contracts: no HTTP shape changes for the browser. `POST /auth/logout` gains a 503, and a session cookie may now arrive
  on any authenticated response. The web app needs no change; the cookie travels by itself.
- The session is only as long-lived as the activity: an idle tab is signed out 30 minutes after its last request, and
  nobody stays signed in past 8 hours, which is also the length of the longest denylist entry.

## Alternatives
- **Tokens held by the frontend with a refresh token** (the SPA calls services directly, refreshing a short access token).
  Rejected: it puts credentials where any script on the page can read them (the reason for ADR 006), moves the refresh
  and revocation logic into the browser, and adds a token surface the BFF doesn't have. The BFF pattern keeps the
  cookie HttpOnly and the session server-checked on every call, and sliding plus a denylist gives the same behaviour a
  refresh token would, at one place we control.
- **Server-side session records** (an opaque cookie looked up in Redis). It would make revocation a delete and sliding a
  TTL refresh, but every request would need the lookup and the stateless JWT chain would be replaced for the sake of one
  claim. The `sid` denylist only stores the sessions that were logged out.
- **Re-issue on every request.** Rejected: a `Set-Cookie` and a signature on every poll and stream for no gain; the
  half-lifetime threshold bounds it to a few re-issues an hour.
- **A longer fixed lifetime.** Rejected: it enlarges the window of a stolen cookie without addressing logout.
- **Revocation TTL equal to the time left to the cap.** Rejected: a token minted at the cap would outlive its denylist
  entry by up to 5 minutes.
