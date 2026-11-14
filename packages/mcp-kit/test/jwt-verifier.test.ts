import { describe, expect, it } from 'vitest';
import { createJwtVerifier, InvalidAccessTokenError } from '../src/jwt-verifier.js';
import { createTestKeys, TEST_ISSUER } from '../src/testing.js';

const AUDIENCE = 'mcp-accounts';

async function setup() {
  const { keys, sign } = await createTestKeys();
  const verify = createJwtVerifier({ issuer: TEST_ISSUER, audience: AUDIENCE, allowedActors: ['bot'], keys });
  return { verify, sign };
}

describe('createJwtVerifier', () => {
  it('accepts an exchanged token for this audience', async () => {
    const { verify, sign } = await setup();
    const principal = await verify(await sign({ aud: AUDIENCE, scope: 'accounts:read' }));
    expect(principal).toMatchObject({
      sub: 'ana',
      scopes: new Set(['accounts:read']),
      actor: 'bot',
      actors: ['bot'],
    });
    expect(principal.jti).toEqual(expect.any(String));
    expect(principal.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it.each([
    ['the bot token (aud=bot)', { aud: 'bot' }],
    ['the other MCP server', { aud: 'mcp-payments' }],
    ['the BFF session (aud=bff)', { aud: 'bff' }],
  ])('rejects a token for %s', async (_, claims) => {
    const { verify, sign } = await setup();
    await expect(verify(await sign(claims))).rejects.toBeInstanceOf(InvalidAccessTokenError);
  });

  it('rejects a token that was not exchanged by an allowed actor', async () => {
    const { verify, sign } = await setup();
    await expect(verify(await sign({ aud: AUDIENCE, act: undefined }))).rejects.toThrow(InvalidAccessTokenError);
    await expect(verify(await sign({ aud: AUDIENCE, act: { sub: 'mallory' } }))).rejects.toThrow(
      InvalidAccessTokenError,
    );
  });

  it('rejects an expired token', async () => {
    const { verify, sign } = await setup();
    await expect(verify(await sign({ aud: AUDIENCE }, -60))).rejects.toThrow(InvalidAccessTokenError);
  });

  it('rejects a token signed by another key', async () => {
    const { verify } = await setup();
    const other = await createTestKeys();
    await expect(verify(await other.sign({ aud: AUDIENCE }))).rejects.toThrow(InvalidAccessTokenError);
  });

  describe('actor chains', () => {
    const GATEWAY_CHAIN = { sub: 'mcp-gateway', act: { sub: 'bot' } };
    const chainVerifier = async (allowedActorChains: string[][], allowedActors?: string[]) => {
      const { keys, sign } = await createTestKeys();
      const verify = createJwtVerifier({
        issuer: TEST_ISSUER,
        audience: AUDIENCE,
        allowedActorChains,
        ...(allowedActors && { allowedActors }),
        keys,
      });
      return { verify, sign };
    };

    it('reads a nested act claim outermost first', async () => {
      const { verify, sign } = await chainVerifier([['mcp-gateway', 'bot']]);
      const principal = await verify(await sign({ aud: AUDIENCE, act: GATEWAY_CHAIN }));
      expect(principal).toMatchObject({ actor: 'mcp-gateway', actors: ['mcp-gateway', 'bot'] });
    });

    it.each([
      ['a token the bot exchanged itself', { sub: 'bot' }],
      ['the gateway acting without the bot behind it', { sub: 'mcp-gateway' }],
      ['the chain in the wrong order', { sub: 'bot', act: { sub: 'mcp-gateway' } }],
      ['a chain with an extra hop', { sub: 'mcp-gateway', act: { sub: 'bot', act: { sub: 'mallory' } } }],
      ['a foreign party inside the chain', { sub: 'mcp-gateway', act: { sub: 'mallory' } }],
      ['a malformed inner act', { sub: 'mcp-gateway', act: 'bot' }],
      ['an empty actor', { sub: '' }],
    ])('rejects %s when only [mcp-gateway, bot] is accepted', async (_, act) => {
      const { verify, sign } = await chainVerifier([['mcp-gateway', 'bot']]);
      await expect(verify(await sign({ aud: AUDIENCE, act }))).rejects.toThrow(InvalidAccessTokenError);
    });

    it('rejects the gateway chain where only the direct bot is accepted (default)', async () => {
      const { verify, sign } = await setup();
      await expect(verify(await sign({ aud: AUDIENCE, act: GATEWAY_CHAIN }))).rejects.toThrow(InvalidAccessTokenError);
    });

    it('accepts both chains when both are configured (the cutover window)', async () => {
      const { verify, sign } = await chainVerifier([['mcp-gateway', 'bot']], ['bot']);
      await expect(verify(await sign({ aud: AUDIENCE, act: { sub: 'bot' } }))).resolves.toMatchObject({
        actors: ['bot'],
      });
      await expect(verify(await sign({ aud: AUDIENCE, act: GATEWAY_CHAIN }))).resolves.toMatchObject({
        actors: ['mcp-gateway', 'bot'],
      });
    });

    it('refuses to build a verifier that accepts nobody', async () => {
      const { keys } = await createTestKeys();
      expect(() => createJwtVerifier({ issuer: TEST_ISSUER, audience: AUDIENCE, keys })).toThrow();
    });
  });
});
