import { createLocalJWKSet, decodeJwt, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, TEST_BOT_SECRET, TEST_GATEWAY_SECRET, TEST_ISSUER } from '../../support/build-app.js';

const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;
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
      ...(scope && { scope }),
    }),
  });
  return { res, body: (await res.json()) as Record<string, string> };
}

async function botToken(env: Env, sub = 'ana') {
  return env.issuer.issueBotToken({ sub, name: 'Ana' });
}

async function gatewayToken(env: Env, scope?: string) {
  const { body } = await post(env, BOT, await botToken(env), 'mcp-gateway', scope);
  return body.access_token as string;
}

describe('MCP gateway hop of the token exchange (ADR 017)', () => {
  it('lets the bot ask for aud=mcp-gateway with every banking scope and act bot', async () => {
    const env = await buildTestApp();
    const { res, body } = await post(env, BOT, await botToken(env), 'mcp-gateway');
    expect(res.status).toBe(200);
    expect(body.scope).toBe('accounts:read beneficiaries:read transfers:prepare transfers:execute');
    const jwks = createLocalJWKSet(await (await env.app.request('/.well-known/jwks.json')).json());
    const { payload } = await jwtVerify(body.access_token as string, jwks, {
      issuer: TEST_ISSUER,
      audience: 'mcp-gateway',
    });
    expect(payload).toMatchObject({ sub: 'ana', act: { sub: 'bot' } });
  });

  it('still lets the bot ask for the backends directly, as today', async () => {
    const env = await buildTestApp();
    const { res, body } = await post(env, BOT, await botToken(env), 'mcp-payments');
    expect(res.status).toBe(200);
    expect(decodeJwt(body.access_token as string).act).toEqual({ sub: 'bot' });
  });

  it('gives the gateway a backend token with a nested act chain', async () => {
    const env = await buildTestApp();
    const { res, body } = await post(env, GATEWAY, await gatewayToken(env), 'mcp-payments');
    expect(res.status).toBe(200);
    expect(body.scope).toBe('beneficiaries:read transfers:prepare transfers:execute');
    expect(decodeJwt(body.access_token as string)).toMatchObject({
      sub: 'ana',
      aud: 'mcp-payments',
      act: { sub: 'mcp-gateway', act: { sub: 'bot' } },
    });
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
      const { body } = await post(env, BOT, await gatewayToken(env), 'mcp-accounts');
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
      const session = await env.issuer.issueSession({ id: 'ana', name: 'Ana' });
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
