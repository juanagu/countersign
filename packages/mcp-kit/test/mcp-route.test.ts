import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { createJwtVerifier } from '../src/jwt-verifier.js';
import { mcpRoute } from '../src/mcp-route.js';
import { createTestKeys, TEST_ISSUER } from '../src/testing.js';

const LIST_TOOLS = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

async function setup() {
  const { keys, sign } = await createTestKeys();
  const built: string[] = [];
  const contexts: { token: string; traceparent: string | undefined }[] = [];
  const app = mcpRoute({
    verify: createJwtVerifier({ issuer: TEST_ISSUER, audience: 'mcp-test', allowedActors: ['bot'], keys }),
    buildServer: (principal, context) => {
      built.push(principal.sub);
      contexts.push(context);
      return new McpServer({ name: 'test', version: '0.0.0' });
    },
  });
  return { app, sign, built, contexts };
}

function post(token?: string, extra: Record<string, string> = {}) {
  return {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...extra,
    },
    body: LIST_TOOLS,
  };
}

describe('mcpRoute', () => {
  it('rejects a request without a bearer token before any MCP handling', async () => {
    const { app, built } = await setup();
    const res = await app.request('/mcp', post());
    expect(res.status).toBe(401);
    expect(built).toEqual([]);
  });

  it('rejects a token for another audience', async () => {
    const { app, sign, built } = await setup();
    const res = await app.request('/mcp', post(await sign({ aud: 'mcp-other' })));
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('invalid_token');
    expect(built).toEqual([]);
  });

  it('builds a server bound to the caller for a valid token', async () => {
    const { app, sign, built } = await setup();
    const res = await app.request('/mcp', post(await sign({ aud: 'mcp-test', sub: 'juan' })));
    expect(res.status).toBe(200);
    expect(built).toEqual(['juan']);
  });

  it('hands the verified token and the caller traceparent to the server builder', async () => {
    const { app, sign, contexts } = await setup();
    const token = await sign({ aud: 'mcp-test' });
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    await app.request('/mcp', post(token, { traceparent }));
    expect(contexts).toEqual([{ token, traceparent }]);
  });

  it('rejects a token whose actor chain is not accepted', async () => {
    const { app, sign, built } = await setup();
    const res = await app.request(
      '/mcp',
      post(await sign({ aud: 'mcp-test', act: { sub: 'x', act: { sub: 'bot' } } })),
    );
    expect(res.status).toBe(401);
    expect(built).toEqual([]);
  });
});
