import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Hono } from 'hono';

/** An MCP client that talks to the Hono app in-process, through the real HTTP route and auth. */
export async function connectClient(app: Hono, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL('http://mcp.test/mcp'), {
    fetch: async (url, init) => app.request(url.toString(), init),
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

export function parseText(result: Awaited<ReturnType<Client['callTool']>>): Record<string, unknown> {
  const first = (result.content as { type: string; text?: string }[])[0];
  return JSON.parse(first?.text ?? '{}') as Record<string, unknown>;
}
