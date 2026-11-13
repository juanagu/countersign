import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { parse } from 'hono/utils/cookie';
import type { SessionClaims, TokenIssuer } from './token-issuer.js';

export const SESSION_COOKIE = 'session';

export type SessionEnv = { Variables: { session: SessionClaims } };

/** Verifies the session cookie from a raw request; undefined when absent or invalid. */
export async function readSession(issuer: TokenIssuer, request: Request): Promise<SessionClaims | undefined> {
  const token = parse(request.headers.get('cookie') ?? '', SESSION_COOKIE)[SESSION_COOKIE];
  if (!token) return undefined;
  return issuer.verifySession(token).catch(() => undefined);
}

export function requireSession(issuer: TokenIssuer): MiddlewareHandler<SessionEnv> {
  return async (c, next) => {
    const token = getCookie(c, SESSION_COOKIE);
    const session = token ? await issuer.verifySession(token).catch(() => undefined) : undefined;
    if (!session) return c.json({ error: 'unauthenticated' }, 401);
    c.set('session', session);
    await next();
  };
}
