import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { defaultBackends } from '../src/features/proxy/backends.js';
import { createProxy } from '../src/features/proxy/proxy.js';
import { createTokenExchanger } from '../src/features/proxy/token-exchanger.js';

const SECRET = 'x'.repeat(16);

describe('mcp-gateway', () => {
  it('reports healthy on /health without a token', async () => {
    const backends = defaultBackends(loadConfig({ MCP_GATEWAY_CLIENT_SECRET: SECRET }));
    const exchanger = createTokenExchanger({
      tokenUrl: 'http://idp.test/token',
      clientId: 'mcp-gateway',
      clientSecret: SECRET,
    });
    const proxy = createProxy({ backends, exchanger, logger: pino({ level: 'silent' }) });
    const res = await createApp({ verify: () => Promise.reject(new Error('unused')), proxy }).request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      status: 'ok',
      service: 'mcp-gateway',
      backends: { accounts: 'ok', payments: 'ok' },
      conflicts: [],
    });
  });

  it('has local defaults', () => {
    expect(loadConfig({ MCP_GATEWAY_CLIENT_SECRET: SECRET })).toEqual({
      port: 8100,
      logLevel: 'info',
      idpIssuer: 'http://localhost:3000',
      idpJwksUrl: 'http://localhost:3000/.well-known/jwks.json',
      idpTokenUrl: 'http://localhost:3000/token',
      clientSecret: SECRET,
      accountsUrl: 'http://localhost:8101/mcp',
      paymentsUrl: 'http://localhost:8102/mcp',
    });
  });

  it('reads its port from MCP_GATEWAY_PORT', () => {
    expect(loadConfig({ MCP_GATEWAY_CLIENT_SECRET: SECRET, MCP_GATEWAY_PORT: '9000' }).port).toBe(9000);
  });

  it('requires a client secret of at least 16 characters', () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ MCP_GATEWAY_CLIENT_SECRET: 'short' })).toThrow();
  });

  it.each(['abc', '0', '-1'])('rejects the port %s', (port) => {
    expect(() => loadConfig({ MCP_GATEWAY_CLIENT_SECRET: SECRET, MCP_GATEWAY_PORT: port })).toThrow();
  });
});
