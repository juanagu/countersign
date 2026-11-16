import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { parse } from 'hono/utils/cookie';
import type { Logger } from 'pino';
import { sessionStanding } from './revocation-guard.js';
import type { RevocationStore } from './revocation-store.js';
import { DOWNSTREAM_TOKEN_TAIL_SECONDS, nowSeconds, shouldSlide } from './session-lifetime.js';
import type { SessionClaims, TokenIssuer } from './token-issuer.js';

export const SESSION_COOKIE = 'session';

export type SessionEnv = { Variables: { session: SessionClaims } };

/** What the session check needs; `cookieSecure` is for the cookie it re-issues. */
export interface SessionDeps {
  issuer: TokenIssuer;
  revocations: RevocationStore;
  cookieSecure: boolean;
  logger: Logger;
}

/**
 * The session cookie for a token that expires at `exp` (seconds since epoch). The browser keeps it for the
 * downstream tail past `exp`, so a logout or login just after the session ended still presents it; every other route
 * rejects the token itself after `exp`.
 */
export function setSessionCookie(c: Context, token: string, exp: number, cookieSecure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: cookieSecure,
    path: '/',
    maxAge: Math.max(0, exp - nowSeconds()) + DOWNSTREAM_TOKEN_TAIL_SECONDS,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

/**
 * The session token's signature and lifetime, without the revocation check. Logout and login use it, with a
 * `toleranceSeconds` for a session that just ended whose downstream tokens are still live.
 */
export async function verifySessionCookie(
  issuer: TokenIssuer,
  request: Request,
  toleranceSeconds = 0,
): Promise<SessionClaims | undefined> {
  const token = parse(request.headers.get('cookie') ?? '', SESSION_COOKIE)[SESSION_COOKIE];
  if (!token) return undefined;
  return issuer.verifySession(token, toleranceSeconds).catch(() => undefined);
}

/** Sessions already verified and checked against revocation, by the request they came in on: once per request. */
const verifiedSessions = new WeakMap<Request, SessionClaims>();

/** Makes `session` the answer of `readSession` for `request`, for a request object that replaced the original. */
export function bindSession(request: Request, session: SessionClaims): void {
  verifiedSessions.set(request, session);
}

export type SessionCheck =
  { status: 'ok'; session: SessionClaims } | { status: 'unauthenticated' } | { status: 'unavailable' };

/**
 * Verifies the session cookie from a raw request and that its `sid` was not logged out. When the revocation store
 * cannot answer the session is refused (fail closed), reported as `unavailable` so a caller can tell an outage from
 * a session that is gone. A request that was verified before is not checked again, so every reader on it sees the
 * same answer.
 */
export async function checkSession(
  { issuer, revocations, logger }: Pick<SessionDeps, 'issuer' | 'revocations' | 'logger'>,
  request: Request,
): Promise<SessionCheck> {
  const known = verifiedSessions.get(request);
  if (known) return { status: 'ok', session: known };
  const session = await verifySessionCookie(issuer, request);
  if (!session) return { status: 'unauthenticated' };
  const standing = await sessionStanding(revocations, logger, 'session', session.sid);
  if (standing !== 'active') return { status: standing === 'revoked' ? 'unauthenticated' : 'unavailable' };
  verifiedSessions.set(request, session);
  return { status: 'ok', session };
}

/** The verified, unrevoked session of a raw request; undefined when absent, invalid, revoked or unverifiable. */
export async function readSession(
  deps: Pick<SessionDeps, 'issuer' | 'revocations' | 'logger'>,
  request: Request,
): Promise<SessionClaims | undefined> {
  const check = await checkSession(deps, request);
  return check.status === 'ok' ? check.session : undefined;
}

/**
 * Authenticates the request and slides the session: with less than half its lifetime left, and room before the
 * absolute cap, the cookie is re-issued with the same `sid` and `auth_time` and a later expiry. The cookie is set on
 * the response the route returns, once it is known to be a success and the `sid` is still not revoked, so a logout
 * that raced the request is not undone. A store outage at the check answers 503, not 401: the session may be fine.
 */
export function requireSession(deps: SessionDeps): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const check = await checkSession(deps, c.req.raw);
    if (check.status === 'unavailable') return c.json({ error: 'session_check_unavailable' }, 503);
    if (check.status === 'unauthenticated') return c.json({ error: 'unauthenticated' }, 401);
    const { session } = check;
    c.set('session', session);
    await next();
    // A failed request is not activity worth extending the session for.
    if (c.res.ok && shouldSlide(session, nowSeconds())) await slideSession(deps, c, session);
  };
}

/** A store that cannot answer, or a logout that landed during the request, means no new cookie; never an error. */
async function slideSession(deps: SessionDeps, c: Context, session: SessionClaims): Promise<void> {
  if ((await sessionStanding(deps.revocations, deps.logger, 'session', session.sid)) !== 'active') return;
  const slid = await deps.issuer.issueSession({ id: session.sub, name: session.name }, session);
  setSessionCookie(c, slid.token, slid.exp, deps.cookieSecure);
}
