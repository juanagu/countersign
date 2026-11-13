import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

describe('bff', () => {
  it('reports healthy on /health', async () => {
    const res = await createApp().request('/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', service: 'bff' });
  });

  it('defaults to port 3000', () => {
    expect(loadConfig({}).port).toBe(3000);
  });

  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ BFF_PORT: 'abc' })).toThrow();
  });
});
