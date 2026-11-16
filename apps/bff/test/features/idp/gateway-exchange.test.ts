import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildTestApp,
  TEST_BOT_SECRET,
  TEST_GATEWAY_SECRET,
  TEST_ISSUER,
  testSession,
} from '../../support/build-app.js';

const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
const PRE_APPROVAL = 'accounts:read beneficiaries:read transfers:prepare';
const BOT = basic('bot', TEST_BOT_SECRET);
const GATEWAY = basic('mcp-gateway', TEST_GATEWAY_SECRET);

type Env = Awaited<ReturnType<typeof buildTestApp>>;

async function post(env: Env, authorization: string, subject_token: string, audience: string, scope?: string) {
  const res = await env.app.request('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization },
    body: new URLSearchParams({
      grant_type: GRANT,
      subject_token,
      subject_token_type: ACCESS,
      audience,
      ...(scope !== undefined && { scope }),
    }),
  });
  return { res, body: (await res.json()) as Record<string, string> };
}

async function botToken(env: Env, sub = 'ana') {
  return env.issuer.issueBotToken(testSession(sub));
}

async function gatewayToken(env: Env, scope = PRE_APPROVAL) {
  const { body } = await post(env, BOT, await botToken(env), 'mcp-gateway', scope);
  return body.access_token as string;
}

describe('MCP gateway hop of the token exchange (ADR 017)', () => {
  it('lets the bot ask for aud=mcp-gateway with the scopes of its skills and act bot', async () => {
    const env = await buildTestApp();
    const { res, body } = await post(env, BOT, await botToken(env), 'mcp-gateway', PRE_APPROVAL);
    expect(res.status).toBe(200);
    expect(body.scope).toBe(PRE_APPROVAL);
    const jwks = createLocalJWKSet(await (await env.app.request('/.well-known/jwks.json')).json());
    const { payload } = await jwtVerify(body.access_token as string, jwks, {
      issuer: TEST_ISSUER,
      audience: 'mcp-gateway',
    });
    expect(payload).toMatchObject({ sub: 'ana', act: { sub: 'bot' } });
  });

  it('refuses a gateway request that repeats scope, not taking the last one or the whole ceiling (RFC 6749 §3.1)', async () => {
    const env = await buildTestApp();
    const gateway = await gatewayToken(env);
    const form = new URLSearchParams({ grant_type: GRANT, subject_token: gateway, subject_token_type: ACCESS });
    form.append('audience', 'mcp-accounts');
    form.append('scope', 'accounts:read');
    form.append('scope', 'accounts:read');
    const res = await env.app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: GATEWAY },
      body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  it.each(['mcp-accounts', 'mcp-payments'])(
    'refuses the bot a token for %s: only the gateway may ask (rule 1)',
    async (audience) => {
      const env = await buildTestApp();
      const { res, body } = await post(env, BOT, await botToken(env), audience, PRE_APPROVAL);
      expect(res.status).toBe(400);
      expect(body).toEqual({ error: 'invalid_target' });
    },
  );

  it('gives the gateway a backend token with a nested act chain', async () => {
    const env = await buildTestApp();
    const { res, body } = await post(env, GATEWAY, await gatewayToken(env), 'mcp-payments');
    expect(res.status).toBe(200);
    expect(body.scope).toBe('beneficiaries:read transfers:prepare');
    expect(decodeJwt(body.access_token as string)).toMatchObject({
      sub: 'ana',
      aud: 'mcp-payments',
      act: { sub: 'mcp-gateway', act: { sub: 'bot' } },
    });
  });

  it('passes the approved transfers:execute-only token on to mcp-payments, and nothing else with it', async () => {
    const env = await buildTestApp();
    const subject = await gatewayToken(env, 'transfers:execute');
    const { body } = await post(env, GATEWAY, subject, 'mcp-payments');
    expect(body.scope).toBe('transfers:execute');
    expect((await post(env, GATEWAY, subject, 'mcp-accounts')).body).toEqual({ error: 'invalid_scope' });
  });

  it('refuses the bot a gateway token with no scope, which used to be the whole ceiling', async () => {
    const env = await buildTestApp();
    const { res, body } = await post(env, BOT, await botToken(env), 'mcp-gateway');
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request' });
  });

  it('keeps the gateway token to the subject scopes: a narrower subject cannot be widened', async () => {
    const env = await buildTestApp();
    const subject = await gatewayToken(env, 'accounts:read');
    const accounts = await post(env, GATEWAY, subject, 'mcp-accounts');
    expect(accounts.body.scope).toBe('accounts:read');
    const payments = await post(env, GATEWAY, subject, 'mcp-payments');
    expect(payments.res.status).toBe(400);
    expect(payments.body).toEqual({ error: 'invalid_scope' });
  });

  it('refuses a requested scope the subject does not hold even when the audience allows it', async () => {
    const env = await buildTestApp();
    const subject = await gatewayToken(env, 'beneficiaries:read');
    const { body } = await post(env, GATEWAY, subject, 'mcp-payments', 'beneficiaries:read transfers:execute');
    expect(body).toEqual({ error: 'invalid_scope' });
  });

  it('refuses a blank scope from the gateway instead of widening to the subject', async () => {
    const env = await buildTestApp();
    const { res, body } = await post(env, GATEWAY, await gatewayToken(env, 'accounts:read'), 'mcp-accounts', '');
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: 'invalid_request' });
  });

  it('never outlives the subject token', async () => {
    const env = await buildTestApp();
    const subject = await gatewayToken(env);
    const { exp } = decodeJwt(subject);
    const { body } = await post(env, GATEWAY, subject, 'mcp-accounts');
    expect(decodeJwt(body.access_token as string).exp).toBeLessThanOrEqual(exp as number);
  });

  describe('a gateway token close to expiry', () => {
    afterEach(() => vi.useRealTimers());

    it('is capped at the subject expiry', async () => {
      const env = await buildTestApp();
      vi.useFakeTimers({ toFake: ['Date'] });
      const now = Math.floor(Date.now() / 1000) * 1000;
      vi.setSystemTime(now);
      const subject = await gatewayToken(env);
      vi.setSystemTime(now + (300 - 6) * 1000);
      const { res, body } = await post(env, GATEWAY, subject, 'mcp-accounts');
      expect(res.status).toBe(200);
      expect(Number(body.expires_in)).toBe(6);
    });
  });

  describe('refusals', () => {
    it.each(['mcp-gateway', 'bot', 'bff', 'mcp-evil'])('the gateway may not ask for audience %s', async (audience) => {
      const env = await buildTestApp();
      const { res, body } = await post(env, GATEWAY, await gatewayToken(env), audience);
      expect(res.status).toBe(400);
      expect(body).toEqual({ error: 'invalid_target' });
    });

    it('does not let the gateway exchange a bot token (wrong subject audience)', async () => {
      const env = await buildTestApp();
      const { body } = await post(env, GATEWAY, await botToken(env), 'mcp-accounts');
      expect(body).toEqual({ error: 'invalid_grant' });
    });

    it('does not let the bot exchange a gateway token (wrong subject audience)', async () => {
      const env = await buildTestApp();
      const { body } = await post(env, BOT, await gatewayToken(env), 'mcp-gateway', PRE_APPROVAL);
      expect(body).toEqual({ error: 'invalid_grant' });
    });

    it('does not let the gateway chain a second hop from a backend token', async () => {
      const env = await buildTestApp();
      const backend = (await post(env, GATEWAY, await gatewayToken(env), 'mcp-accounts')).body.access_token;
      const { body } = await post(env, GATEWAY, backend as string, 'mcp-accounts');
      expect(body).toEqual({ error: 'invalid_grant' });
    });

    it('does not let the gateway exchange a session token', async () => {
      const env = await buildTestApp();
      const session = await env.issuer.issueSession({ id: 'ana', name: 'Ana' }).then((session) => session.token);
      const { body } = await post(env, GATEWAY, session, 'mcp-accounts');
      expect(body).toEqual({ error: 'invalid_grant' });
    });

    it('rejects a wrong gateway secret with 401', async () => {
      const env = await buildTestApp();
      const { res } = await post(env, basic('mcp-gateway', TEST_BOT_SECRET), await gatewayToken(env), 'mcp-accounts');
      expect(res.status).toBe(401);
    });

    it('has no gateway client when its secret is not configured', async () => {
      const env = await buildTestApp(undefined, { clients: { bot: TEST_BOT_SECRET } });
      const { res } = await post(env, GATEWAY, await gatewayToken(env), 'mcp-accounts');
      expect(res.status).toBe(401);
    });
  });
});
