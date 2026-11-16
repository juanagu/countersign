import { Hono } from 'hono';
import { z } from 'zod';
import { DEMO_USERS, findDemoUser } from './demo-users.js';
import { revocationTtlSeconds, nowSeconds } from './session-lifetime.js';
import {
  clearSessionCookie,
  requireSession,
  setSessionCookie,
  verifySessionCookie,
  type SessionDeps,
  type SessionEnv,
} from './session.js';

const loginBody = z.object({ username: z.string().min(1).max(64) });

export type IdpRoutesOptions = SessionDeps;

export function idpRoutes(deps: IdpRoutesOptions): Hono<SessionEnv> {
  const { issuer, revocations, cookieSecure, logger } = deps;
  const app = new Hono<SessionEnv>();

  app.get('/.well-known/jwks.json', async (c) => c.json(await issuer.jwks()));

  app.get('/auth/demo-users', (c) => c.json(DEMO_USERS));

  app.post('/auth/login', async (c) => {
    const body = loginBody.safeParse(await c.req.json().catch(() => null));
    const user = body.success ? findDemoUser(body.data.username) : undefined;
    if (!user) return c.json({ error: 'unknown_user' }, 401);
    const session = await issuer.issueSession(user);
    setSessionCookie(c, session.token, session.exp, cookieSecure);
    return c.json({ id: user.id, name: user.name });
  });

  // Always clears the cookie and answers 204 without a session. With one, the `sid` is revoked first; if the store
  // cannot record it the answer is 503, so the caller does not believe a still-valid session is gone.
  app.post('/auth/logout', async (c) => {
    const session = await verifySessionCookie(issuer, c.req.raw);
    clearSessionCookie(c);
    if (!session) return c.body(null, 204);
    try {
      await revocations.revoke(session.sid, revocationTtlSeconds(session.authTime, nowSeconds()));
    } catch (error) {
      logger.error(
        {
          event: 'revocation_store_unavailable',
          check: 'logout',
          err: error instanceof Error ? error.message : String(error),
        },
        'logout could not revoke the session',
      );
      return c.json({ error: 'logout_not_recorded' }, 503);
    }
    return c.body(null, 204);
  });

  app.get('/auth/me', requireSession(deps), (c) => {
    const { sub, name } = c.get('session');
    return c.json({ id: sub, name });
  });

  return app;
}
