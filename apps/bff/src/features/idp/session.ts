import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { parse } from 'hono/utils/cookie';
import type { Logger } from 'pino';
import { isRevokedOrUnknown } from './revocation-guard.js';
import type { RevocationStore } from './revocation-store.js';
import { nowSeconds, shouldSlide } from './session-lifetime.js';
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

/** The session cookie for a token that expires at `exp` (seconds since epoch). */
export function setSessionCookie(c: Context, token: string, exp: number, cookieSecure: boolean): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Strict',
    secure: cookieSecure,
    path: '/',
    maxAge: Math.max(0, exp - nowSeconds()),
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

/**
 * Verifies the session cookie from a raw request and that its `sid` was not logged out; undefined when absent,
 * invalid or revoked. When the revocation store cannot answer the session is refused (fail closed). A request that
 * was verified before is not checked again, so every reader on it sees the same answer.
 */
export async function readSession(
  { issuer, revocations, logger }: Pick<SessionDeps, 'issuer' | 'revocations' | 'logger'>,
  request: Request,
): Promise<SessionClaims | undefined> {
  const known = verifiedSessions.get(request);
  if (known) return known;
  const session = await verifySessionCookie(issuer, request);
  if (!session) return undefined;
  if (await isRevokedOrUnknown(revocations, logger, 'session', session.sid)) return undefined;
  verifiedSessions.set(request, session);
  return session;
}

/**
 * Authenticates the request and slides the session: with less than half its lifetime left, and room before the
 * absolute cap, the cookie is re-issued with the same `sid` and `auth_time` and a later expiry. It is set on the
 * response the route returns, before a byte of a streamed body is read.
 */
export function requireSession(deps: SessionDeps): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const session = await readSession(deps, c.req.raw);
    if (!session) return c.json({ error: 'unauthenticated' }, 401);
    c.set('session', session);
    const slid = shouldSlide(session, nowSeconds()) ? await slideSession(deps.issuer, session) : undefined;
    await next();
    // A failed request is not activity worth extending the session for.
    if (slid && c.res.ok) setSessionCookie(c, slid.token, slid.exp, deps.cookieSecure);
  };
}

function slideSession(issuer: TokenIssuer, session: SessionClaims) {
  return issuer.issueSession({ id: session.sub, name: session.name }, session);
}
