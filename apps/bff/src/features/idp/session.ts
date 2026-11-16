import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { parse } from 'hono/utils/cookie';
import type { Logger } from 'pino';
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

/** The session token's signature and lifetime, without the revocation check: logout uses this one. */
export async function verifySessionCookie(issuer: TokenIssuer, request: Request): Promise<SessionClaims | undefined> {
  const token = parse(request.headers.get('cookie') ?? '', SESSION_COOKIE)[SESSION_COOKIE];
  if (!token) return undefined;
  return issuer.verifySession(token).catch(() => undefined);
}

/**
 * Verifies the session cookie from a raw request and that its `sid` was not logged out; undefined when absent,
 * invalid or revoked. When the revocation store cannot answer the session is refused (fail closed), and the log
 * line never carries the `sid`.
 */
export async function readSession(
  { issuer, revocations, logger }: Pick<SessionDeps, 'issuer' | 'revocations' | 'logger'>,
  request: Request,
): Promise<SessionClaims | undefined> {
  const session = await verifySessionCookie(issuer, request);
  if (!session) return undefined;
  try {
    return (await revocations.isRevoked(session.sid)) ? undefined : session;
  } catch (error) {
    logger.error(
      {
        event: 'revocation_store_unavailable',
        check: 'session',
        err: error instanceof Error ? error.message : String(error),
      },
      'session refused: revocation store unavailable',
    );
    return undefined;
  }
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
    if (slid) setSessionCookie(c, slid.token, slid.exp, deps.cookieSecure);
  };
}

function slideSession(issuer: TokenIssuer, session: SessionClaims) {
  return issuer.issueSession({ id: session.sub, name: session.name }, session);
}
