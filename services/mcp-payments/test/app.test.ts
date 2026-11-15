import { createJwtVerifier } from '@poc/mcp-kit';
import { createTestKeys, TEST_ISSUER } from '@poc/mcp-kit/testing';
import { describe, expect, it } from 'vitest';
import { ALLOWED_ACTOR_CHAINS, AUDIENCE, createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { InMemoryTransfersRepository } from './support/in-memory-transfers.js';

const refuseEveryToken = () => Promise.reject(new Error('no token in these tests'));

describe('mcp-payments', () => {
  it('reports healthy on /health without a token', async () => {
    const res = await createApp({
      verify: refuseEveryToken,
      verifyStepUp: async () => undefined,
      transfers: new InMemoryTransfersRepository(),
    }).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'mcp-payments' });
  });

  it('has local defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 8102,
      logLevel: 'info',
      idpIssuer: 'http://localhost:3000',
      idpJwksUrl: 'http://localhost:3000/.well-known/jwks.json',
      databaseUrl: 'postgres://bank:bank@localhost:5432/bank',
    });
  });

  it('reads its port from MCP_PAYMENTS_PORT', () => {
    expect(loadConfig({ MCP_PAYMENTS_PORT: '9000' }).port).toBe(9000);
  });

  it.each(['abc', '0', '-1', '80.5'])('rejects the port %s', (port) => {
    expect(() => loadConfig({ MCP_PAYMENTS_PORT: port })).toThrow();
  });

  it.each(['not a url', '/.well-known/jwks.json'])('rejects IDP_JWKS_URL %s', (url) => {
    expect(() => loadConfig({ IDP_JWKS_URL: url })).toThrow();
  });
  describe('who may present a token (ADR 017)', () => {
    const GATEWAY_CHAIN = { sub: 'mcp-gateway', act: { sub: 'bot' } };

    async function verifier() {
      const { keys, sign } = await createTestKeys();
      const verify = createJwtVerifier({
        issuer: TEST_ISSUER,
        audience: AUDIENCE,
        allowedActorChains: ALLOWED_ACTOR_CHAINS,
        keys,
      });
      return { verify, sign };
    }

    it('accepts a token the gateway exchanged for the bot', async () => {
      const { verify, sign } = await verifier();
      await expect(verify(await sign({ aud: 'mcp-payments', act: GATEWAY_CHAIN }))).resolves.toMatchObject({
        actors: ['mcp-gateway', 'bot'],
      });
    });

    it.each([
      ['a token the bot exchanged for this server itself (act bot only)', { aud: 'mcp-payments', act: { sub: 'bot' } }],
      ["the gateway's own aud=mcp-gateway token", { aud: 'mcp-gateway', act: { sub: 'bot' } }],
      ['a gateway token acting alone', { aud: 'mcp-payments', act: { sub: 'mcp-gateway' } }],
      ['a chain in the wrong order', { aud: 'mcp-payments', act: { sub: 'bot', act: { sub: 'mcp-gateway' } } }],
    ])('refuses %s', async (_, claims) => {
      const { verify, sign } = await verifier();
      await expect(verify(await sign(claims))).rejects.toThrow();
    });
  });
});
