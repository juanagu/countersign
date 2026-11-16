import { createLocalJWKSet, decodeJwt as joseDecodeJwt, jwtVerify } from 'jose';
import { pino } from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../../src/app.js';
import { TokenIssuer } from '../../../src/features/idp/token-issuer.js';
import { buildTestApp, TEST_BOT_SECRET, TEST_ISSUER, testDeps, testSession } from '../../support/build-app.js';

const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';
const PRE_APPROVAL = 'accounts:read beneficiaries:read transfers:prepare';
const decodeJwt = (token: string) => ({ payload: joseDecodeJwt(token) });
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

// The bot must always send a scope, so the helper does by default; `scope: undefined` leaves it out.
async function exchange(fields: Record<string, string | undefined>, authorization = basic('bot', TEST_BOT_SECRET)) {
  const { app, issuer } = await buildTestApp();
  const botToken = await issuer.issueBotToken(testSession());
  const body = new URLSearchParams(
    Object.entries({
      grant_type: GRANT,
      subject_token: botToken,
      subject_token_type: ACCESS,
      audience: 'mcp-gateway',
      scope: PRE_APPROVAL,
      ...fields,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const res = await app.request('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization },
    body,
  });
  return { res, app, issuer, botToken };
}

describe('POST /token (token exchange)', () => {
  it('exchanges a bot token for a gateway-bound token with the requested scopes and an act claim', async () => {
    const { res, app } = await exchange({ scope: PRE_APPROVAL });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; scope: string; expires_in: number };
    expect(body.scope).toBe(PRE_APPROVAL);
    expect(body.expires_in).toBeLessThanOrEqual(300);
    const jwks = createLocalJWKSet(await (await app.request('/.well-known/jwks.json')).json());
    const { payload } = await jwtVerify(body.access_token, jwks, { issuer: TEST_ISSUER, audience: 'mcp-gateway' });
    expect(payload).toMatchObject({ sub: 'ana', act: { sub: 'bot' } });
  });

  it('grants transfers:execute when it is asked for alone, for the approved call (rule 3)', async () => {
    const { res } = await exchange({ scope: 'transfers:execute' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { scope: string }).scope).toBe('transfers:execute');
  });

  it('narrows to a requested subset', async () => {
    const { res } = await exchange({ scope: 'beneficiaries:read' });
    expect(((await res.json()) as { scope: string }).scope).toBe('beneficiaries:read');
  });

  it('issues a repeated scope once', async () => {
    const { res } = await exchange({ scope: 'accounts:read accounts:read  beneficiaries:read accounts:read' });
    expect(((await res.json()) as { scope: string }).scope).toBe('accounts:read beneficiaries:read');
  });

  it('refuses a scope parameter that is repeated (RFC 6749 §3.1)', async () => {
    const { app, issuer } = await buildTestApp();
    const botToken = await issuer.issueBotToken(testSession());
    const form = new URLSearchParams({ grant_type: GRANT, subject_token: botToken, subject_token_type: ACCESS });
    form.append('audience', 'mcp-gateway');
    form.append('scope', 'accounts:read');
    form.append('scope', 'transfers:execute');
    const res = await app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic('bot', TEST_BOT_SECRET) },
      body: form,
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request' });
  });

  describe('audit of a token with a solo scope', () => {
    async function exchangeLogged(scope: string) {
      const lines: Record<string, unknown>[] = [];
      const logger = pino({ level: 'info' }, { write: (line: string) => lines.push(JSON.parse(line)) });
      const { app, issuer } = await buildTestApp(undefined, { logger });
      const botToken = await issuer.issueBotToken(testSession());
      const res = await app.request('/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic('bot', TEST_BOT_SECRET) },
        body: new URLSearchParams({
          grant_type: GRANT,
          subject_token: botToken,
          subject_token_type: ACCESS,
          audience: 'mcp-gateway',
          scope,
        }),
      });
      return { lines, issued: (await res.json()) as { access_token: string } };
    }

    it('logs client, sub, audience, scope, jti and exp, and no token', async () => {
      const { lines, issued } = await exchangeLogged('transfers:execute');
      const { payload } = decodeJwt(issued.access_token);
      expect(lines.filter((line) => line['event'] === 'solo_scope_token_issued')).toEqual([
        expect.objectContaining({
          client: 'bot',
          sub: 'ana',
          audience: 'mcp-gateway',
          scope: 'transfers:execute',
          jti: payload.jti,
          exp: payload.exp,
        }),
      ]);
      expect(JSON.stringify(lines)).not.toContain(issued.access_token);
    });

    it('logs nothing for a token without a solo scope', async () => {
      const { lines } = await exchangeLogged(PRE_APPROVAL);
      expect(lines.filter((line) => line['event'] === 'solo_scope_token_issued')).toEqual([]);
    });
  });

  it.each([
    ['no scope from the bot, which must not fall back to the whole ceiling', { scope: undefined }, 'invalid_request'],
    ['a blank scope, which must not fall back to the whole ceiling', { scope: '' }, 'invalid_request'],
    ['a scope of only spaces', { scope: '   ' }, 'invalid_request'],
    ['a scope the audience does not allow', { scope: 'accounts:read accounts:write' }, 'invalid_scope'],
    ['a scope outside the ceiling, never trimmed to what is allowed', { scope: 'accounts:write' }, 'invalid_scope'],
    [
      'transfers:execute with another scope, which it must be alone',
      { scope: 'transfers:prepare transfers:execute' },
      'invalid_scope',
    ],
    ['an unknown audience', { audience: 'mcp-evil' }, 'invalid_target'],
    ['mcp-accounts, which only the gateway may ask for (rule 1)', { audience: 'mcp-accounts' }, 'invalid_target'],
    ['mcp-payments, which only the gateway may ask for (rule 1)', { audience: 'mcp-payments' }, 'invalid_target'],
    ['the bot itself as audience', { audience: 'bot' }, 'invalid_target'],
    ['an Object.prototype key as audience', { audience: 'constructor' }, 'invalid_target'],
    ['another prototype key as audience', { audience: '__proto__' }, 'invalid_target'],
    ['a wrong grant type', { grant_type: 'client_credentials' }, 'unsupported_grant_type'],
    ['a garbage subject token', { subject_token: 'not-a-jwt' }, 'invalid_grant'],
  ])('rejects %s', async (_, fields, error) => {
    const { res } = await exchange(fields);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  describe('a subject token close to expiry', () => {
    afterEach(() => vi.useRealTimers());

    // The bot token lives 300 s; jump to `remaining` seconds before its exp, then exchange it.
    async function exchangeWithRemaining(remaining: number) {
      const { app, issuer } = await buildTestApp();
      vi.useFakeTimers({ toFake: ['Date'] });
      const issuedAt = Math.floor(Date.now() / 1000);
      vi.setSystemTime(issuedAt * 1000);
      const botToken = await issuer.issueBotToken(testSession());
      vi.setSystemTime((issuedAt + 300 - remaining) * 1000);
      return app.request('/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic('bot', TEST_BOT_SECRET) },
        body: new URLSearchParams({
          grant_type: GRANT,
          subject_token: botToken,
          subject_token_type: ACCESS,
          audience: 'mcp-gateway',
          scope: PRE_APPROVAL,
        }),
      });
    }

    it.each([1, 4])('answers invalid_grant with %i s left, instead of a token dead on arrival', async (remaining) => {
      const res = await exchangeWithRemaining(remaining);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid_grant' });
    });

    it('issues a token capped at the subject token expiry with 5 s left', async () => {
      const res = await exchangeWithRemaining(5);
      expect(res.status).toBe(200);
      expect(((await res.json()) as { expires_in: number }).expires_in).toBe(5);
    });
  });

  it('rejects a session token (aud=bff) as subject: only the bot token can be exchanged', async () => {
    const { app, issuer } = await buildTestApp();
    const session = await issuer.issueSession({ id: 'ana', name: 'Ana' }).then((session) => session.token);
    const res = await app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic('bot', TEST_BOT_SECRET) },
      body: new URLSearchParams({
        grant_type: GRANT,
        subject_token: session,
        subject_token_type: ACCESS,
        audience: 'mcp-gateway',
        scope: PRE_APPROVAL,
      }),
    });
    expect(await res.json()).toEqual({ error: 'invalid_grant' });
  });

  it.each([
    ['no client credentials', ''],
    ['a wrong secret', basic('bot', 'nope')],
    ['an unknown client', basic('mallory', TEST_BOT_SECRET)],
    ['an Object.prototype key as client id', basic('constructor', 'x')],
  ])('rejects %s with 401', async (_, authorization) => {
    const { res } = await exchange({}, authorization);
    expect(res.status).toBe(401);
  });

  describe('client secrets with reserved characters (RFC 6749 §2.3.1)', () => {
    const SECRET = 'colon:plus+space pct%-0123456789';

    async function exchangeAs(authorization: string) {
      const issuer = await TokenIssuer.create(TEST_ISSUER);
      const app = createApp(testDeps(issuer, { clients: { bot: SECRET } }));
      const res = await app.request('/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', authorization },
        body: new URLSearchParams({
          grant_type: GRANT,
          subject_token: await issuer.issueBotToken(testSession()),
          subject_token_type: ACCESS,
          audience: 'mcp-gateway',
          scope: PRE_APPROVAL,
        }),
      });
      return res.status;
    }
    const formEncode = (value: string) => new URLSearchParams({ v: value }).toString().slice('v='.length);

    it('accepts a form-encoded secret, splitting only on the first colon', async () => {
      expect(await exchangeAs(basic('bot', formEncode(SECRET)))).toBe(200);
    });

    it('accepts a raw colon in the secret', async () => {
      expect(await exchangeAs(basic('bot', formEncode(SECRET).replaceAll('%3A', ':')))).toBe(200);
    });

    it.each([
      ['the secret cut at its first colon', basic('bot', 'colon')],
      ['the secret not form-encoded', basic('bot', SECRET)],
      ['a malformed escape', basic('bot', '%zz')],
      ['no colon at all', `Basic ${Buffer.from('bot').toString('base64')}`],
    ])('rejects %s with 401', async (_, authorization) => {
      expect(await exchangeAs(authorization)).toBe(401);
    });
  });

  it('rejects a JSON body', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: basic('bot', TEST_BOT_SECRET) },
      body: '{}',
    });
    expect(res.status).toBe(400);
  });
});
