import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOWNSTREAM_TOKEN_TAIL_SECONDS,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
  SESSION_SLIDE_BELOW_SECONDS,
} from '../../../src/features/idp/session-lifetime.js';
import { buildTestApp, loginCookie } from '../../support/build-app.js';
import { CountingRevocationStore } from '../../support/revocation-doubles.js';
import { MemoryRevocationStore } from '../../support/memory-revocation-store.js';

const T0 = new Date('2026-03-02T09:00:00Z');
const MINUTE_MS = 60_000;
const advanceMinutes = (minutes: number) => vi.setSystemTime(new Date(Date.now() + minutes * MINUTE_MS));
const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

type TestApp = Awaited<ReturnType<typeof buildTestApp>>['app'];

const claimsOf = (cookie: string) => decodeJwt(cookie.replace('session=', ''));

/** GET /auth/me with `cookie`; the refreshed cookie, when the response set one. */
async function me(app: TestApp, cookie: string) {
  const res = await app.request('/auth/me', { headers: { cookie } });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, setCookie, cookie: setCookie?.split(';')[0] };
}

describe('sliding session', () => {
  it('logs in with an opaque random sid, the login time and the idle lifetime', async () => {
    const { app } = await buildTestApp();
    const first = claimsOf(await loginCookie(app));
    const second = claimsOf(await loginCookie(app));
    expect(first.sid).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(second.sid).not.toBe(first.sid);
    expect(first.auth_time).toBe(nowSeconds());
    expect(first.exp).toBe(nowSeconds() + SESSION_IDLE_TTL_SECONDS);
  });

  it('leaves the cookie alone while more than half the lifetime is left', async () => {
    const { app } = await buildTestApp();
    const cookie = await loginCookie(app);
    advanceMinutes(SESSION_SLIDE_BELOW_SECONDS / 60 - 1);
    expect(await me(app, cookie)).toMatchObject({ status: 200, setCookie: null });
  });

  it('re-issues the cookie once less than half is left, with the same sid and auth_time and a full lifetime', async () => {
    const { app } = await buildTestApp();
    const cookie = await loginCookie(app);
    const before = claimsOf(cookie);
    advanceMinutes(SESSION_SLIDE_BELOW_SECONDS / 60 + 1);

    const slid = await me(app, cookie);

    expect(slid.status).toBe(200);
    expect(slid.setCookie).toContain('HttpOnly');
    expect(slid.setCookie).toContain('SameSite=Strict');
    const after = claimsOf(slid.cookie ?? '');
    expect(after.sid).toBe(before.sid);
    expect(after.auth_time).toBe(before.auth_time);
    expect(after.exp).toBe(nowSeconds() + SESSION_IDLE_TTL_SECONDS);
    expect(slid.setCookie).toContain(`Max-Age=${SESSION_IDLE_TTL_SECONDS + DOWNSTREAM_TOKEN_TAIL_SECONDS}`);
  });

  it('keeps an active user signed in past the idle lifetime, and signs an idle one out', async () => {
    const { app } = await buildTestApp();
    let cookie = await loginCookie(app);
    for (let step = 0; step < 6; step += 1) {
      advanceMinutes(16);
      const slid = await me(app, cookie);
      expect(slid.status).toBe(200);
      cookie = slid.cookie ?? cookie;
    }
    // 96 minutes after login, three times the idle lifetime.
    advanceMinutes(SESSION_IDLE_TTL_SECONDS / 60 + 1);
    expect((await me(app, cookie)).status).toBe(401);
  });

  it('stops re-issuing at the absolute cap: the last cookie ends there and the session expires', async () => {
    const { app } = await buildTestApp();
    let cookie = await loginCookie(app);
    const { sid, auth_time: authTime } = claimsOf(cookie);
    const cap = Number(authTime) + SESSION_ABSOLUTE_TTL_SECONDS;
    const reissues: ReturnType<typeof claimsOf>[] = [];

    while (nowSeconds() + 16 * 60 < cap) {
      advanceMinutes(16);
      const slid = await me(app, cookie);
      expect(slid.status).toBe(200);
      if (slid.cookie) {
        cookie = slid.cookie;
        reissues.push(claimsOf(cookie));
      }
    }
    expect(reissues.length).toBeGreaterThan(20);
    expect(reissues.every((claims) => claims.sid === sid && claims.auth_time === authTime)).toBe(true);
    expect(Math.max(...reissues.map((claims) => Number(claims.exp)))).toBeLessThanOrEqual(cap);

    // The last re-issue was clamped to the cap; with less than half left, a later request has nothing to extend.
    expect(claimsOf(cookie).exp).toBe(cap);
    advanceMinutes(2);
    expect(await me(app, cookie)).toMatchObject({ status: 200, setCookie: null });

    vi.setSystemTime(new Date((cap + 1) * 1000));
    expect((await me(app, cookie)).status).toBe(401);
  });

  it('refuses a session whose auth_time is past the cap even if its exp is later', async () => {
    const { app, issuer } = await buildTestApp();
    const authTime = nowSeconds() - SESSION_ABSOLUTE_TTL_SECONDS - 60;
    const forged = await issuer['sign'](
      { name: 'Ana', sid: 'sid-old', auth_time: authTime },
      'ana',
      'bff',
      SESSION_IDLE_TTL_SECONDS,
    );
    expect((await me(app, `session=${forged}`)).status).toBe(401);
  });

  it('re-issues nothing for a request that fails after authenticating', async () => {
    const { app } = await buildTestApp();
    const cookie = await loginCookie(app);
    advanceMinutes(SESSION_SLIDE_BELOW_SECONDS / 60 + 1);

    const res = await app.request('/auth/step-up', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ pin: 'not-a-pin' }),
    });

    expect(res.status).toBe(400);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('gives a cookie re-issued before logout the same 401 as the one it replaced', async () => {
    const { app } = await buildTestApp();
    const original = await loginCookie(app);
    advanceMinutes(SESSION_SLIDE_BELOW_SECONDS / 60 + 1);
    const slid = (await me(app, original)).cookie ?? '';
    expect(claimsOf(slid).sid).toBe(claimsOf(original).sid);

    const logout = await app.request('/auth/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: slid },
    });

    expect(logout.status).toBe(204);
    expect((await me(app, slid)).status).toBe(401);
    expect((await me(app, original)).status).toBe(401);
  });

  it('does not re-issue for a request that has no valid session', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/auth/me');
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('keeps the browser cookie for the downstream tail past exp, on login and on a slide, so a late logout carries it', async () => {
    const { app } = await buildTestApp();
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"username":"ana"}',
    });
    expect(login.headers.get('set-cookie')).toContain(
      `Max-Age=${SESSION_IDLE_TTL_SECONDS + DOWNSTREAM_TOKEN_TAIL_SECONDS}`,
    );
  });

  it('does not slide for a response that raced a logout: the revocation is re-checked before the cookie is set', async () => {
    const store = new CountingRevocationStore(1); // The session check passes; every later lookup sees the logout.
    const { app } = await buildTestApp(undefined, { revocations: store });
    const cookie = await loginCookie(app);
    advanceMinutes(SESSION_SLIDE_BELOW_SECONDS / 60 + 1);

    const result = await me(app, cookie);

    expect(result.status).toBe(200);
    expect(result.setCookie).toBeNull();
  });

  it('skips the slide, without failing the response, when the store errors after the request ran', async () => {
    class FailsAfterFirst extends MemoryRevocationStore {
      lookups = 0;
      override async isRevoked(sid: string): Promise<boolean> {
        this.lookups += 1;
        if (this.lookups > 1) throw new Error('redis down');
        return super.isRevoked(sid);
      }
    }
    const { app } = await buildTestApp(undefined, { revocations: new FailsAfterFirst() });
    const cookie = await loginCookie(app);
    advanceMinutes(SESSION_SLIDE_BELOW_SECONDS / 60 + 1);

    const result = await me(app, cookie);

    expect(result.status).toBe(200);
    expect(result.setCookie).toBeNull();
  });
});
