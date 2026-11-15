import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildTestApp } from './support/build-app.js';

describe('bff', () => {
  it('reports healthy on /health', async () => {
    const { app } = await buildTestApp();
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'bff' });
  });

  it('defaults to port 3000 and insecure cookies for local dev', () => {
    const config = loadConfig({ BOT_CLIENT_SECRET: 'x'.repeat(16) });
    expect(config.port).toBe(3000);
    expect(config.cookieSecure).toBe(false);
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ BFF_PORT: 'abc', BOT_CLIENT_SECRET: 'x'.repeat(16) })).toThrow();
  });

  it('requires a bot client secret', () => {
    expect(() => loadConfig({})).toThrow();
  });

  it('treats the gateway client secret as optional, so an older .env still boots', () => {
    expect(loadConfig({ BOT_CLIENT_SECRET: 'x'.repeat(16) }).mcpGatewayClientSecret).toBeUndefined();
    expect(
      loadConfig({ BOT_CLIENT_SECRET: 'x'.repeat(16), MCP_GATEWAY_CLIENT_SECRET: '' }).mcpGatewayClientSecret,
    ).toBe(undefined);
  });

  it('rejects a short gateway client secret', () => {
    expect(() => loadConfig({ BOT_CLIENT_SECRET: 'x'.repeat(16), MCP_GATEWAY_CLIENT_SECRET: 'short' })).toThrow();
  });
});
