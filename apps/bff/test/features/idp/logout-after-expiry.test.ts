import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOWNSTREAM_TOKEN_TAIL_SECONDS,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_IDLE_TTL_SECONDS,
} from '../../../src/features/idp/session-lifetime.js';
import { buildTestApp, loginCookie, TEST_BOT_SECRET } from '../../support/build-app.js';
import { RecordingRevocationStore } from '../../support/revocation-doubles.js';

const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';
const SCOPE = 'accounts:read';
const advanceSeconds = (seconds: number) => vi.setSystemTime(new Date(Date.now() + seconds * 1000));
const nowSeconds = () => Math.floor(Date.now() / 1000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-02T09:00:00Z'));
});
afterEach(() => vi.useRealTimers());

async function setup() {
  const revocations = new RecordingRevocationStore();
  const env = await buildTestApp('http://bot.invalid/agent', { revocations });
  const logout = (cookie: string) =>
    env.app.request('/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json', cookie } });
  const exchange = (subject: string) =>
    env.app.request('/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`bot:${TEST_BOT_SECRET}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: GRANT,
        subject_token: subject,
        subject_token_type: ACCESS,
        audience: 'mcp-gateway',
        scope: SCOPE,
      }),
    });
  return { ...env, revocations, logout, exchange };
}

describe('logout just after the session ended', () => {
  it('still revokes the sid, so a bot token minted before the expiry gets invalid_grant at the exchange', async () => {
    const t = await setup();
    const cookie = await loginCookie(t.app);
    const sid = String(decodeJwt(cookie.replace('session=', '')).sid);
    advanceSeconds(SESSION_IDLE_TTL_SECONDS - 60);
    const botToken = await t.issuer.issueBotToken({ sub: 'ana', sid });
    expect((await t.exchange(botToken)).status).toBe(200);

    advanceSeconds(2 * 60); // one minute past the session's exp, the bot token still has minutes to live
    const res = await t.logout(cookie);

    expect(res.status).toBe(204);
    expect(t.revocations.calls.map((call) => call.sid)).toEqual([sid]);
    const refused = await t.exchange(botToken);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'invalid_grant' });
  });

  it('applies the same tolerance to the absolute cap', async () => {
    const t = await setup();
    const lineage = { sid: 'sid-capped', authTime: nowSeconds() - SESSION_ABSOLUTE_TTL_SECONDS + 60 };
    const session = await t.issuer.issueSession({ id: 'ana', name: 'Ana' }, lineage);
    advanceSeconds(120); // one minute past the cap, which is also the token's exp

    const res = await t.logout(`session=${session.token}`);

    expect(res.status).toBe(204);
    expect(t.revocations.calls.map((call) => call.sid)).toEqual(['sid-capped']);
  });

  it('records the entry for the tail of tokens already minted, never a zero or negative time', async () => {
    const t = await setup();
    const cookie = await loginCookie(t.app);
    advanceSeconds(SESSION_IDLE_TTL_SECONDS + 60);
    await t.logout(cookie);
    expect(t.revocations.calls[0]?.ttlSeconds).toBeGreaterThan(0);
  });

  it('ignores a session that ended longer ago than any token minted from it can live', async () => {
    const t = await setup();
    const cookie = await loginCookie(t.app);
    advanceSeconds(SESSION_IDLE_TTL_SECONDS + DOWNSTREAM_TOKEN_TAIL_SECONDS + 60);

    const res = await t.logout(cookie);

    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/^session=;/);
    expect(t.revocations.calls).toEqual([]);
  });

  it('does not let the tolerance revive the session for anything else', async () => {
    const t = await setup();
    const cookie = await loginCookie(t.app);
    advanceSeconds(SESSION_IDLE_TTL_SECONDS + 60);
    expect((await t.app.request('/auth/me', { headers: { cookie } })).status).toBe(401);
  });
});
