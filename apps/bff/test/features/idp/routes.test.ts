import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { buildTestApp, loginCookie, TEST_ISSUER } from '../../support/build-app.js';

describe('mock IdP', () => {
  it('logs in a demo user with an HttpOnly, SameSite=Strict session cookie', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ana' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'ana', name: 'Ana Gómez' });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('lists the demo users for the login picker', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/auth/demo-users');
    expect(await res.json()).toEqual([
      { id: 'ana', name: 'Ana Gómez' },
      { id: 'juan', name: 'Juan Pérez' },
    ]);
  });

  it('rejects an unknown user', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'mallory' }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a malformed login body', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/auth/login', { method: 'POST', body: 'not json' });
    expect(res.status).toBe(401);
  });

  it('issues a session token with aud=bff that verifies against the JWKS', async () => {
    const { app } = await buildTestApp();
    const token = (await loginCookie(app)).replace('session=', '');
    const jwks = createLocalJWKSet(await (await app.request('/.well-known/jwks.json')).json());
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: 'bff' });
    expect(payload.sub).toBe('ana');
  });

  it('returns the current user from the session', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/auth/me', { headers: { cookie: await loginCookie(app, 'juan') } });
    expect(await res.json()).toEqual({ id: 'juan', name: 'Juan Pérez' });
  });

  it('rejects /auth/me without a session or with a forged one', async () => {
    const { app } = await buildTestApp();
    const other = await buildTestApp();
    const forged = await loginCookie(other.app);
    expect((await app.request('/auth/me')).status).toBe(401);
    expect((await app.request('/auth/me', { headers: { cookie: forged } })).status).toBe(401);
  });

  it('does not accept a bot token as a session', async () => {
    const { app, issuer } = await buildTestApp();
    const botToken = await issuer.issueBotToken({ sub: 'ana', name: 'Ana Gómez' });
    const res = await app.request('/auth/me', { headers: { cookie: `session=${botToken}` } });
    expect(res.status).toBe(401);
  });
});
