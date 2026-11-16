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
  `/copilotkit/*` mount. The slide follows a successful response start (`2xx`): never for a request that failed
  authentication or answered an error status. A stream that fails after its `200` still slides, bounded by the 8-hour
  cap. After `next()` the middleware re-checks that the `sid` is not revoked and only then signs and attaches the new
  session, so a logout that raced the request is not undone; if the store errors there, the slide is skipped (no
  cookie) and the response is not failed.
- **The browser keeps the cookie `DOWNSTREAM_TOKEN_TAIL_SECONDS` (5 minutes) past the JWT's `exp`**: its `Max-Age` is
  `exp - now + tail`. Otherwise the browser deletes the cookie at `exp` and a logout a minute later carries nothing to
  revoke. The JWT's own `exp` still makes every route behind `requireSession` reject it after `exp`; only logout and
  login apply the tolerance.

**`sid` on everything minted from a session.** The bot token, the step-up token, the history-restore token and every
exchanged token (gateway and backends) carry the session's `sid`. The exchange copies the subject's `sid` onto what it
issues. The bot, the gateway and the MCP servers never read it: they verify what they always did and ignore the claim.
A session token or an exchange subject without a `sid` is refused (`401` at the session check, `invalid_grant` at
`/token`); nothing in production issues one.

**History restore.** The runner's `connect` receives only headers, not the request, so the verified session cannot be
handed to it directly. The headers it gets are the agent's own, with the client's merged underneath: the runtime keeps
the agent's `Authorization` (the per-request `aud=bot` token the factory minted from the verified session) over a
client-supplied one of any casing, and an integration test through `createApp` pins that. `BotThreadHistory` verifies
that token, requires its `sub` to be the thread's owner, and mints the restore token with its `sid`, expiring no later
than the caller token (`min(now + 5 min, caller exp)`). A missing, foreign or `sid`-less caller token gets an empty
history and no call to the bot; a missing one is logged at error, because it would mean the runtime stopped forwarding
the header and no thread restores.

**Revocation.**
- `POST /auth/logout` verifies the cookie (signature and lifetime, not revocation), records its `sid` as revoked, and
  only then deletes the cookie. Without a valid session it only deletes the cookie and answers 204. It verifies with a
  clock tolerance of 5 minutes, the tail of a downstream token, and applies the same tolerance to the absolute cap: a
  logout at `exp + 1 min` still revokes, because a bot token minted before `exp` can be exchanged for minutes more.
  A cookie that ended more than 5 minutes ago has nothing left to revoke and is only cleared.
- `POST /auth/login` presented with a valid session cookie (same 5-minute tolerance) revokes that `sid` before
  issuing the new session, so signing in again does not leave the previous session alive. If the store cannot record
  it, login answers 503 `previous_session_not_revoked`, sets no cookie and leaves the old one in place: refusing is
  consistent with fail closed, and the customer can retry. A login with no session cookie never touches the store.
- The denylist is the `RevocationStore` interface with a Redis implementation (`auth:revoked:{sid}`, value `1`, the
  Redis instance of ADR 015) and an in-memory double for tests. The TTL is the time left to the 8-hour cap plus 5 minutes, the
  lifetime of an `aud=bot` token, because a token minted from the session just before the cap could be presented for
  exchange that long after it.
- Checks: `requireSession`, and the `identifyUser` and per-request agent callbacks of the CopilotKit runtime, refuse a
  revoked `sid` with 401; history restore checks the caller's `sid` itself after verifying its token (a revoked or unverifiable one restores nothing); `/token` refuses a subject whose `sid` is revoked with `invalid_grant`, at both hops (bot to
  gateway, gateway to backend). A bot run already under way when the customer logs out keeps the tokens it already
  holds, each at most 5 minutes, and mints no new one once the logout is recorded. An exchange whose check was answered
  a moment before the logout still gets its token, which lives at most 5 minutes like the others; a run therefore
  can mint nothing only from the instant the denylist write completes, not from the instant the customer clicks.
- **Fail closed.** If the store cannot answer, the session check answers 503 `{ "error": "session_check_unavailable" }`
  (not 401: the session may be valid, and the web app signs out only on a 401, so an outage does not show the login
  screen), the exchange answers `invalid_grant`, and each logs one structured line (`event: revocation_store_unavailable`,
  `check: session | exchange | logout | login | history`, the
  error message; never the `sid` or the cookie). One helper (`revocation-guard.ts`) holds that try/catch and the log
  for all four callers, and strips the `sid` from the message in case a driver put the key in it. The Redis store has
  its own client (`createRedisClient` with `disableOfflineQueue`), so while Redis is down a command fails at once and no stale command
  piles up to run when it returns; every command also has a 1-second deadline, for a Redis that is connected but
  hung. A logout the store could not record answers 503 and keeps the cookie, so the customer can retry and the
  session is not mistaken for gone.
- **Once per request.** `requireSession` checks the cookie and the denylist once and remembers the verified claims
  against the request; the CopilotKit agents factory and `identifyUser` read them from there. The chat handler binds
  them to the request object it passes to the runtime, because `bodyLimit` swaps in a new one. A request the runtime
  would hand over as a different object (not the case in the multi-route mode this uses) falls back to checking again.

## Consequences
- A Redis outage makes every authenticated request answer 503 until it returns; the web app keeps the user signed in and the chat is down. That is the
  price of refusing to guess; the thread log already depends on the same Redis, so the chat was down in that case anyway.
- An authenticated chat request does one denylist lookup, and the 401-or-500 split between the middleware and the
  runtime's callbacks is gone: a session valid at the door stays valid for that request, a logout landing after the
  check takes effect on the next one. A revocation that lands mid-request does not stop a run already started; its
  tokens are the 5-minute ones and the next exchange is refused.
- A token already minted is not recalled: a bot token lives up to 5 minutes after logout and the bot accepts it, a gateway
  token likewise at the gateway and backends. Revocation stops the mint, not what exists. Shortening those lifetimes
  or introspecting at the gateway is the production step.
- Residuals: a logout later than 5 minutes after the session ended does not record anything (every token minted from
  it is dead by then); a `sid` identifies one session, so logging out of one device leaves the same user's other sessions
  alive (by design); the history-restore token is read from a forwarded header, not
  from the request, so a runtime that stops forwarding it silently disables restore (logged at error).
- A BFF restart still rotates the signing key and ends every session (ADR 006), so the denylist only has to cover the
  life of one key; it is kept in Redis anyway so that several BFF replicas would agree.
- Contracts: no HTTP shape changes for the browser. `POST /auth/logout` and `POST /auth/login` gain a 503 (the cookie
  is left as it was), the authenticated routes answer 503 `session_check_unavailable` during a store outage, and a session cookie may now arrive on any successful authenticated response. The web app needs no change; the cookie travels by itself.
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
