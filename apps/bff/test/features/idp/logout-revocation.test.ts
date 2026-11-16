import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  DOWNSTREAM_TOKEN_TAIL_SECONDS,
  SESSION_ABSOLUTE_TTL_SECONDS,
} from '../../../src/features/idp/session-lifetime.js';
import {
  buildTestApp,
  loginCookie,
  TEST_BOT_SECRET,
  TEST_GATEWAY_SECRET,
  testSession,
} from '../../support/build-app.js';
import { startFakeBot } from '../../support/fake-bot.js';
import {
  capturingLogger,
  RecordingRevocationStore,
  UnavailableRevocationStore,
} from '../../support/revocation-doubles.js';

const RUN = '/copilotkit/agent/default/run';
const CONNECT = '/copilotkit/agent/default/connect';
const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';
const PRE_APPROVAL = 'accounts:read beneficiaries:read transfers:prepare';
const DRAFT = {
  draft_id: 'drf_0b3a6f9e-4c1d-4e2a-9f7b-1a2b3c4d5e6f',
  amount: '50000.00',
  currency: 'ARS',
  beneficiary_id: 'ben-juan-ana',
  pin: '123456',
};

const sidOf = (cookie: string) => String(decodeJwt(cookie.replace('session=', '')).sid);
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const json = { 'content-type': 'application/json' };

function chatBody(threadId: string = randomUUID()) {
  return JSON.stringify({
    threadId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: 'user', content: 'hola' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
}

async function setup(overrides: Parameters<typeof buildTestApp>[1] = {}, history: Record<string, unknown[]> = {}) {
  const bot = await startFakeBot({ delayMs: 1, deltas: ['hola'], history });
  const revocations = new RecordingRevocationStore();
  const env = await buildTestApp(bot.url, { revocations, ...overrides });
  const post = (path: string, cookie: string, body: string) =>
    env.app.request(path, {
      method: 'POST',
      headers: { ...json, accept: 'text/event-stream', cookie },
      body,
    });
  const stepUp = (cookie: string) => post('/auth/step-up', cookie, JSON.stringify(DRAFT));
  const logout = (cookie?: string) =>
    env.app.request('/auth/logout', { method: 'POST', headers: { ...json, ...(cookie && { cookie }) } });
  const me = (cookie: string) => env.app.request('/auth/me', { headers: { cookie } });
  const exchange = (client: string, secret: string, subject: string, audience: string, scope: string) =>
    env.app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic(client, secret) },
      body: new URLSearchParams({
        grant_type: GRANT,
        subject_token: subject,
        subject_token_type: ACCESS,
        audience,
        scope,
      }),
    });
  const botExchange = (subject: string) => exchange('bot', TEST_BOT_SECRET, subject, 'mcp-gateway', PRE_APPROVAL);
  const gatewayExchange = (subject: string) =>
    exchange('mcp-gateway', TEST_GATEWAY_SECRET, subject, 'mcp-accounts', 'accounts:read');
  return { ...env, bot, revocations, post, stepUp, logout, me, botExchange, gatewayExchange };
}

describe('logout revokes the session', () => {
  it('answers 204, clears the cookie, and the old cookie gets 401 on /auth/me, a chat run, a connect and step-up', async () => {
    const t = await setup();
    const cookie = await loginCookie(t.app);
    expect((await t.me(cookie)).status).toBe(200);

    const res = await t.logout(cookie);

    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toMatch(/^session=;.*(Max-Age=0|Expires=)/);
    expect((await t.me(cookie)).status).toBe(401);
    expect((await t.post(RUN, cookie, chatBody())).status).toBe(401);
    expect((await t.post(CONNECT, cookie, chatBody())).status).toBe(401);
    const stepUp = await t.stepUp(cookie);
    expect(stepUp.status).toBe(401);
    expect(await stepUp.text()).not.toContain('step_up_token');
    expect(t.bot.runs).toBe(0);
    t.bot.server.close();
  });

  it('records the sid until the absolute cap plus the tail of tokens already minted from it', async () => {
    const t = await setup();
    const cookie = await loginCookie(t.app);
    await t.logout(cookie);
    expect(t.revocations.calls).toHaveLength(1);
    const [entry] = t.revocations.calls;
    expect(entry?.sid).toBe(sidOf(cookie));
    expect(entry?.ttlSeconds).toBeGreaterThan(SESSION_ABSOLUTE_TTL_SECONDS - 5);
    expect(entry?.ttlSeconds).toBeLessThanOrEqual(SESSION_ABSOLUTE_TTL_SECONDS + DOWNSTREAM_TOKEN_TAIL_SECONDS);
    t.bot.server.close();
  });

  it('revokes only that session: the same user signed in elsewhere stays signed in', async () => {
    const t = await setup();
    const laptop = await loginCookie(t.app, 'ana');
    const phone = await loginCookie(t.app, 'ana');
    await t.logout(laptop);
    expect((await t.me(laptop)).status).toBe(401);
    expect((await t.me(phone)).status).toBe(200);
    t.bot.server.close();
  });

  it('answers 204 and clears the cookie with no session, an unverifiable one or a forged one', async () => {
    const t = await setup();
    const other = await buildTestApp();
    const forged = await loginCookie(other.app);
    for (const cookie of [undefined, 'session=not-a-jwt', forged]) {
      const res = await t.logout(cookie);
      expect(res.status).toBe(204);
      expect(res.headers.get('set-cookie')).toMatch(/^session=;/);
    }
    expect(t.revocations.calls).toEqual([]);
    expect((await t.me(forged)).status).toBe(401);
    t.bot.server.close();
  });

  it('is idempotent: a second logout with the same cookie is still 204', async () => {
    const t = await setup();
    const cookie = await loginCookie(t.app);
    expect((await t.logout(cookie)).status).toBe(204);
    expect((await t.logout(cookie)).status).toBe(204);
    t.bot.server.close();
  });
});

describe('sid on every token minted from the session', () => {
  it('stamps the same sid on the bot token, the step-up token, the history token and the exchanged tokens', async () => {
    const t = await setup({}, { 'ana:t-1': [] });
    const cookie = await loginCookie(t.app);
    const sid = sidOf(cookie);

    await (await t.post(RUN, cookie, chatBody())).text();
    expect(t.bot.runClaims.map((claims) => claims.sid)).toEqual([sid]);
    await (await t.post(CONNECT, cookie, chatBody('t-1'))).text();
    const stepUp = (await (await t.stepUp(cookie)).json()) as { step_up_token: string };
    const botToken = await t.issuer.issueBotToken({ sub: 'ana', sid });
    const gateway = (await (await t.botExchange(botToken)).json()) as { access_token: string };
    const backend = (await (await t.gatewayExchange(gateway.access_token)).json()) as { access_token: string };

    expect(decodeJwt(stepUp.step_up_token).sid).toBe(sid);
    expect(decodeJwt(gateway.access_token).sid).toBe(sid);
    expect(decodeJwt(backend.access_token).sid).toBe(sid);
    expect(t.bot.historyClaims.map((claims) => claims.sid)).toEqual([sid]);
    t.bot.server.close();
  });
});

describe('the token exchange honours logout', () => {
  it('refuses a bot token whose sid is revoked with invalid_grant, and serves one that is not', async () => {
    const t = await setup();
    const live = testSession();
    const dead = testSession();
    await t.revocations.revoke(dead.sid, 60);

    const ok = await t.botExchange(await t.issuer.issueBotToken(live));
    const refused = await t.botExchange(await t.issuer.issueBotToken(dead));

    expect(ok.status).toBe(200);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'invalid_grant' });
    t.bot.server.close();
  });

  it('stops a run in progress at logout from getting new gateway tokens, at either hop', async () => {
    const t = await setup();
    const cookie = await loginCookie(t.app);
    const botToken = await t.issuer.issueBotToken({ sub: 'ana', sid: sidOf(cookie) });
    const gateway = (await (await t.botExchange(botToken)).json()) as { access_token: string };

    await t.logout(cookie);

    expect(await (await t.botExchange(botToken)).json()).toEqual({ error: 'invalid_grant' });
    expect(await (await t.gatewayExchange(gateway.access_token)).json()).toEqual({ error: 'invalid_grant' });
    t.bot.server.close();
  });

  it('refuses a subject token with no sid, at both hops', async () => {
    const t = await setup();
    const noSidBot = await t.issuer['sign']({ scope: 'chat' }, 'ana', 'bot', 300);
    const noSidGateway = await t.issuer['sign'](
      { scope: 'accounts:read', act: { sub: 'bot' } },
      'ana',
      'mcp-gateway',
      300,
    );
    expect(await (await t.botExchange(noSidBot)).json()).toEqual({ error: 'invalid_grant' });
    expect(await (await t.gatewayExchange(noSidGateway)).json()).toEqual({ error: 'invalid_grant' });
    t.bot.server.close();
  });
});

describe('a session token with no sid', () => {
  it('is refused on /auth/me, step-up and chat', async () => {
    const t = await setup();
    const legacy = `session=${await t.issuer['sign']({ name: 'Ana', auth_time: Math.floor(Date.now() / 1000) }, 'ana', 'bff', 1800)}`;
    expect((await t.me(legacy)).status).toBe(401);
    expect((await t.stepUp(legacy)).status).toBe(401);
    expect((await t.post(RUN, legacy, chatBody())).status).toBe(401);
    expect(t.bot.runs).toBe(0);
    t.bot.server.close();
  });

  it('is refused without auth_time too', async () => {
    const t = await setup();
    const noAuthTime = `session=${await t.issuer['sign']({ name: 'Ana', sid: 'sid-x' }, 'ana', 'bff', 1800)}`;
    expect((await t.me(noAuthTime)).status).toBe(401);
    t.bot.server.close();
  });
});

describe('when the revocation store is unavailable it fails closed', () => {
  async function down() {
    const { logger, lines } = capturingLogger();
    const t = await setup({ revocations: new UnavailableRevocationStore(), logger });
    // Sign in before the outage: the store is only consulted on checks, so login still works.
    const cookie = await loginCookie(t.app);
    return { ...t, cookie, lines };
  }

  it('answers 401 at the session check on every route', async () => {
    const t = await down();
    expect((await t.me(t.cookie)).status).toBe(401);
    expect((await t.post(RUN, t.cookie, chatBody())).status).toBe(401);
    expect((await t.post(CONNECT, t.cookie, chatBody())).status).toBe(401);
    expect((await t.stepUp(t.cookie)).status).toBe(401);
    expect(t.bot.runs).toBe(0);
    t.bot.server.close();
  });

  it('answers invalid_grant at the exchange', async () => {
    const t = await down();
    const botToken = await t.issuer.issueBotToken(testSession());
    const res = await t.botExchange(botToken);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
    t.bot.server.close();
  });

  it('logs it as a structured event without the sid or the cookie', async () => {
    const t = await down();
    const sid = sidOf(t.cookie);
    await t.me(t.cookie);
    await t.botExchange(await t.issuer.issueBotToken({ sub: 'ana', sid }));
    await t.logout(t.cookie);

    const events = t.lines.map((line) => JSON.parse(line) as { event?: string; check?: string });
    expect(events.map((e) => e.check)).toEqual(['session', 'exchange', 'logout']);
    expect(events.every((e) => e.event === 'revocation_store_unavailable')).toBe(true);
    const log = t.lines.join('');
    expect(log).not.toContain(sid);
    expect(log).not.toContain(t.cookie.replace('session=', ''));
    t.bot.server.close();
  });

  it('refuses a logout it could not record with 503, but still clears the cookie', async () => {
    const t = await down();
    const res = await t.logout(t.cookie);
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toMatch(/^session=;/);
    t.bot.server.close();
  });
});
