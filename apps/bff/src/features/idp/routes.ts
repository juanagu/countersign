import { Hono } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { DEMO_USERS, findDemoUser } from './demo-users.js';
import { requireSession, SESSION_COOKIE, type SessionEnv } from './session.js';
import { SESSION_TTL_SECONDS, type TokenIssuer } from './token-issuer.js';

const loginBody = z.object({ username: z.string().min(1).max(64) });

export interface IdpRoutesOptions {
  issuer: TokenIssuer;
  cookieSecure: boolean;
}

export function idpRoutes({ issuer, cookieSecure }: IdpRoutesOptions): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();

  app.get('/.well-known/jwks.json', async (c) => c.json(await issuer.jwks()));

  app.get('/auth/demo-users', (c) => c.json(DEMO_USERS));

  app.post('/auth/login', async (c) => {
    const body = loginBody.safeParse(await c.req.json().catch(() => null));
    const user = body.success ? findDemoUser(body.data.username) : undefined;
    if (!user) return c.json({ error: 'unknown_user' }, 401);
    setCookie(c, SESSION_COOKIE, await issuer.issueSession(user), {
      httpOnly: true,
      sameSite: 'Strict',
      secure: cookieSecure,
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    return c.json({ id: user.id, name: user.name });
  });

  app.post('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.body(null, 204);
  });

  app.get('/auth/me', requireSession(issuer), (c) => {
    const { sub, name } = c.get('session');
    return c.json({ id: sub, name });
  });

  return app;
}
