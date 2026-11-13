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
    expect(principal).toEqual({ sub: 'ana', scopes: new Set(['accounts:read']), actor: 'bot' });
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
});
