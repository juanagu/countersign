import { createLocalJWKSet, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { buildTestApp, TEST_BOT_SECRET, TEST_ISSUER } from '../../support/build-app.js';

const GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS = 'urn:ietf:params:oauth:token-type:access_token';
const basic = (id: string, secret: string) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

async function exchange(fields: Record<string, string>, authorization = basic('bot', TEST_BOT_SECRET)) {
  const { app, issuer } = await buildTestApp();
  const botToken = await issuer.issueBotToken({ sub: 'ana', name: 'Ana Gómez' });
  const body = new URLSearchParams({
    grant_type: GRANT,
    subject_token: botToken,
    subject_token_type: ACCESS,
    audience: 'mcp-accounts',
    ...fields,
  });
  const res = await app.request('/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization },
    body,
  });
  return { res, app, issuer, botToken };
}

describe('POST /token (token exchange)', () => {
  it('exchanges a bot token for an audience-bound token with narrowed scopes and an act claim', async () => {
    const { res, app } = await exchange({});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; scope: string; expires_in: number };
    expect(body.scope).toBe('accounts:read');
    expect(body.expires_in).toBeLessThanOrEqual(300);
    const jwks = createLocalJWKSet(await (await app.request('/.well-known/jwks.json')).json());
    const { payload } = await jwtVerify(body.access_token, jwks, { issuer: TEST_ISSUER, audience: 'mcp-accounts' });
    expect(payload).toMatchObject({ sub: 'ana', scope: 'accounts:read', act: { sub: 'bot' } });
  });

  it('narrows to a requested subset', async () => {
    const { res } = await exchange({ audience: 'mcp-payments', scope: 'beneficiaries:read' });
    expect(((await res.json()) as { scope: string }).scope).toBe('beneficiaries:read');
  });

  it.each([
    ['a scope the audience does not allow', { scope: 'accounts:read transfers:prepare' }, 'invalid_scope'],
    ['an unknown audience', { audience: 'mcp-evil' }, 'invalid_target'],
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

  it('rejects a session token (aud=bff) as subject: only the bot token can be exchanged', async () => {
    const { app, issuer } = await buildTestApp();
    const session = await issuer.issueSession({ id: 'ana', name: 'Ana Gómez' });
    const res = await app.request('/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: basic('bot', TEST_BOT_SECRET) },
      body: new URLSearchParams({
        grant_type: GRANT,
        subject_token: session,
        subject_token_type: ACCESS,
        audience: 'mcp-accounts',
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
