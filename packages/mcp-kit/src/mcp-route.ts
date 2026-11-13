import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { InvalidAccessTokenError, type VerifyAccessToken } from './jwt-verifier.js';
import type { Principal } from './principal.js';

export const MCP_PATH = '/mcp';

export interface McpRouteOptions {
  verify: VerifyAccessToken;
  /** Builds a server whose tools are bound to this caller. One per request (stateless transport). */
  buildServer: (principal: Principal) => McpServer;
  onRejected?: (reason: string) => void;
}

function unauthorized(error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': `Bearer error="${error}"` },
  });
}

export function mcpRoute({ verify, buildServer, onRejected }: McpRouteOptions): Hono {
  const app = new Hono();
  app.all(MCP_PATH, async (c) => {
    const header = c.req.header('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
    if (!token) return unauthorized('invalid_request');

    let principal: Principal;
    try {
      principal = await verify(token);
    } catch (error) {
      if (!(error instanceof InvalidAccessTokenError)) throw error;
      onRejected?.(error.message);
      return unauthorized('invalid_token');
    }

    const server = buildServer(principal);
    // No session id generator: stateless mode, one transport per request.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
}
