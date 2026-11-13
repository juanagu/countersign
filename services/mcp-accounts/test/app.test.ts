import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { InMemoryAccountsRepository } from './support/in-memory-accounts.js';

const refuseEveryToken = () => Promise.reject(new Error('no token in these tests'));

describe('mcp-accounts', () => {
  it('reports healthy on /health without a token', async () => {
    const res = await createApp({ verify: refuseEveryToken, accounts: new InMemoryAccountsRepository() }).request(
      '/health',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'mcp-accounts' });
  });

  it('has local defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 8101,
      logLevel: 'info',
      idpIssuer: 'http://localhost:3000',
      idpJwksUrl: 'http://localhost:3000/.well-known/jwks.json',
      databaseUrl: 'postgres://bank:bank@localhost:5432/bank',
    });
  });

  it('reads its port from MCP_ACCOUNTS_PORT', () => {
    expect(loadConfig({ MCP_ACCOUNTS_PORT: '9000' }).port).toBe(9000);
  });

  it.each(['abc', '0', '-1', '80.5'])('rejects the port %s', (port) => {
    expect(() => loadConfig({ MCP_ACCOUNTS_PORT: port })).toThrow();
  });

  it.each(['not a url', '/.well-known/jwks.json'])('rejects IDP_JWKS_URL %s', (url) => {
    expect(() => loadConfig({ IDP_JWKS_URL: url })).toThrow();
  });
});
