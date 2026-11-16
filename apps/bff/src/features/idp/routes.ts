import { Hono } from 'hono';
import { z } from 'zod';
import { DEMO_USERS, findDemoUser } from './demo-users.js';
import { recordRevocation } from './revocation-guard.js';
import { DOWNSTREAM_TOKEN_TAIL_SECONDS, nowSeconds, revocationTtlSeconds } from './session-lifetime.js';
import {
  clearSessionCookie,
  requireSession,
  setSessionCookie,
  verifySessionCookie,
  type SessionDeps,
  type SessionEnv,
} from './session.js';
import type { RevocationCheck } from './revocation-guard.js';
import type { SessionClaims } from './token-issuer.js';

const loginBody = z.object({ username: z.string().min(1).max(64) });

export type IdpRoutesOptions = SessionDeps;

export function idpRoutes(deps: IdpRoutesOptions): Hono<SessionEnv> {
  const { issuer, revocations, cookieSecure, logger } = deps;
  const app = new Hono<SessionEnv>();

  app.get('/.well-known/jwks.json', async (c) => c.json(await issuer.jwks()));

  app.get('/auth/demo-users', (c) => c.json(DEMO_USERS));

  /** Records the session's `sid` as revoked; false when the store could not take it. */
  const revoke = (session: SessionClaims, check: RevocationCheck): Promise<boolean> =>
    recordRevocation(revocations, logger, check, session.sid, revocationTtlSeconds(session.authTime, nowSeconds()));

  // The session a request carries, even if it ended moments ago: its downstream tokens outlive it by the tail.
  const endingSession = (request: Request) => verifySessionCookie(issuer, request, DOWNSTREAM_TOKEN_TAIL_SECONDS);

  // A login while holding a session replaces it, so the old `sid` is revoked first. If the store cannot record
  // that the answer is 503 with the old cookie untouched: signing in must not leave the previous session alive.
  app.post('/auth/login', async (c) => {
    const body = loginBody.safeParse(await c.req.json().catch(() => null));
    const user = body.success ? findDemoUser(body.data.username) : undefined;
    if (!user) return c.json({ error: 'unknown_user' }, 401);
    const previous = await endingSession(c.req.raw);
    if (previous && !(await revoke(previous, 'login'))) return c.json({ error: 'previous_session_not_revoked' }, 503);
    const session = await issuer.issueSession(user);
    setSessionCookie(c, session.token, session.exp, cookieSecure);
    return c.json({ id: user.id, name: user.name });
  });

  // Without a valid session this only clears the cookie. With one, the `sid` is revoked first and the cookie is
  // cleared after: if the store cannot record it the answer is 503 and the cookie stays, so a retry can still revoke.
  app.post('/auth/logout', async (c) => {
    const session = await endingSession(c.req.raw);
    if (session && !(await revoke(session, 'logout'))) return c.json({ error: 'logout_not_recorded' }, 503);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  app.get('/auth/me', requireSession(deps), (c) => {
    const { sub, name } = c.get('session');
    return c.json({ id: sub, name });
  });

  return app;
}
