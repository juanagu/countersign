import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('mcp-payments', () => {
  it('reports healthy on /health', async () => {
    const res = await createApp().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'mcp-payments' });
  });

  it('defaults to port 8102', () => {
    expect(loadConfig({}).port).toBe(8102);
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ MCP_PAYMENTS_PORT: 'abc' })).toThrow();
  });
});
