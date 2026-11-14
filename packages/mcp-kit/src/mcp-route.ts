import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { Hono } from 'hono';
import { InvalidAccessTokenError, type VerifyAccessToken } from './jwt-verifier.js';
import type { Principal } from './principal.js';

export const MCP_PATH = '/mcp';

/** What `mcpRoute` builds per request: an `McpServer` or a low-level `Server`. */
export interface ConnectableServer {
  connect(transport: Transport): Promise<void>;
}

/** The raw request facts a server may need beyond who the caller is. */
export interface McpRequestContext {
  /** The verified bearer token. Only a gateway that exchanges it downstream has a use for it. */
  token: string;
  /** The caller's W3C `traceparent` header, when it sent one. */
  traceparent: string | undefined;
}

export interface McpRouteOptions {
  verify: VerifyAccessToken;
  /** Builds a server whose tools are bound to this caller. One per request (stateless transport). */
  buildServer: (principal: Principal, context: McpRequestContext) => ConnectableServer;
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

    const server = buildServer(principal, { token, traceparent: c.req.header('traceparent') });
    // No session id generator: stateless mode, one transport per request.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(c.req.raw);
  });
  return app;
}
