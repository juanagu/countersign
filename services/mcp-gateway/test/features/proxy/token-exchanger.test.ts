import type { Principal } from '@poc/mcp-kit';
import { describe, expect, it } from 'vitest';
import { createTokenExchanger, TokenExchangeError } from '../../../src/features/proxy/token-exchanger.js';

const principal = (sub: string, jti: string): Principal => ({
  sub,
  jti,
  scopes: new Set(),
  actor: 'bot',
  actors: ['bot'],
  expiresAt: 0,
});

function setup(expiresIn = 300) {
  const clock = { t: 1_000_000 };
  const calls: { subject: string; audience: string; authorization: string }[] = [];
  let failWith: Response | undefined;
  const fetchFake: typeof fetch = async (_url, init) => {
    const body = init?.body as URLSearchParams;
    calls.push({
      subject: body.get('subject_token') ?? '',
      audience: body.get('audience') ?? '',
      authorization: new Headers(init?.headers).get('authorization') ?? '',
    });
    await Promise.resolve();
    return failWith ?? Response.json({ access_token: `tok-${calls.length}`, expires_in: expiresIn });
  };
  const exchanger = createTokenExchanger({
    tokenUrl: 'http://idp.test/token',
    clientId: 'mcp-gateway',
    clientSecret: 'secret:with+chars',
    fetch: fetchFake,
    now: () => clock.t,
  });
  return { exchanger, calls, clock, fail: (response: Response | undefined) => (failWith = response) };
}

describe('createTokenExchanger', () => {
  it('authenticates as the gateway client, form-encoding the secret', async () => {
    const { exchanger, calls } = setup();
    await exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts');
    expect(calls[0]?.authorization).toBe(
      `Basic ${Buffer.from('mcp-gateway:secret%3Awith%2Bchars').toString('base64')}`,
    );
    expect(calls[0]).toMatchObject({ subject: 'in-1', audience: 'mcp-accounts' });
  });

  it('reuses a token for the same inbound jti, customer and audience', async () => {
    const { exchanger, calls } = setup();
    const first = await exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts');
    const second = await exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts');
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
  });

  it('shares one exchange between concurrent calls', async () => {
    const { exchanger, calls } = setup();
    await Promise.all([
      exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts'),
      exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts'),
    ]);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['another customer', principal('ana', 'j1'), 'mcp-accounts'],
    ['another inbound token of the same customer', principal('juan', 'j2'), 'mcp-accounts'],
    ['another audience', principal('juan', 'j1'), 'mcp-payments'],
  ])('does not reuse a token for %s', async (_, other, audience) => {
    const { exchanger, calls } = setup();
    const first = await exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts');
    const second = await exchanger.tokenFor(other, 'in-2', audience);
    expect(second).not.toBe(first);
    expect(calls).toHaveLength(2);
  });

  it('does not reuse a token a little before it expires', async () => {
    const { exchanger, calls, clock } = setup(300);
    await exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts');
    clock.t += 289_000;
    await exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts');
    expect(calls).toHaveLength(1);
    clock.t += 2_000;
    await exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts');
    expect(calls).toHaveLength(2);
  });

  it('fails without caching when the IdP refuses, and does not leak its body', async () => {
    const { exchanger, calls, fail } = setup();
    fail(new Response('{"error":"invalid_grant","subject_token":"in-1"}', { status: 400 }));
    const error = await exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TokenExchangeError);
    expect(String((error as Error).message)).not.toContain('in-1');
    fail(undefined);
    await expect(exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts')).resolves.toMatch(/^tok-/);
    expect(calls).toHaveLength(2);
  });

  it('refuses an unexpected IdP body', async () => {
    const { exchanger, fail } = setup();
    fail(Response.json({ nope: true }));
    await expect(exchanger.tokenFor(principal('juan', 'j1'), 'in-1', 'mcp-accounts')).rejects.toBeInstanceOf(
      TokenExchangeError,
    );
  });
});
