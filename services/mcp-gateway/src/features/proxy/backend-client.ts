import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Backend } from './backends.js';

export const BACKEND_TIMEOUT_MS = 10_000;

/**
 * The backend could not be reached, timed out or answered 5xx (`unavailable`: counts toward its breaker),
 * or refused the request with a 4xx (`rejected`: it answered, so it is up).
 */
export class BackendFailure extends Error {
  constructor(readonly kind: 'unavailable' | 'rejected') {
    super(`backend ${kind}`);
  }
}

/** What the gateway needs from a backend: nothing else of the MCP surface is exposed. */
export interface BackendClient {
  listTools(backend: Backend, session: BackendSession): Promise<Tool[]>;
  callTool(
    backend: Backend,
    session: BackendSession,
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<CallToolResult>;
}

export interface BackendSession {
  /** The token exchanged for this backend's audience, never the one the gateway received. */
  token: string;
  headers?: Record<string, string>;
}

export interface BackendClientOptions {
  timeoutMs?: number;
  fetch?: typeof fetch;
}

function classify(error: unknown): unknown {
  if (error instanceof McpError) {
    // A JSON-RPC answer is the backend talking, unless it is our own timeout or a dropped connection.
    const down = error.code === ErrorCode.RequestTimeout || error.code === ErrorCode.ConnectionClosed;
    return down ? new BackendFailure('unavailable') : error;
  }
  if (error instanceof StreamableHTTPError) {
    const status = error.code;
    return new BackendFailure(status !== undefined && status < 500 ? 'rejected' : 'unavailable');
  }
  return new BackendFailure('unavailable');
}

export function createBackendClient({
  timeoutMs = BACKEND_TIMEOUT_MS,
  fetch: doFetch,
}: BackendClientOptions = {}): BackendClient {
  async function withClient<T>(backend: Backend, session: BackendSession, run: (client: Client) => Promise<T>) {
    const transport = new StreamableHTTPClientTransport(new URL(backend.url), {
      ...(doFetch && { fetch: doFetch }),
      requestInit: { headers: { authorization: `Bearer ${session.token}`, ...session.headers } },
    });
    const client = new Client({ name: 'mcp-gateway', version: '0.1.0' });
    try {
      await client.connect(transport, { timeout: timeoutMs });
      return await run(client);
    } catch (error) {
      throw classify(error);
    } finally {
      await client.close().catch(() => undefined);
    }
  }

  return {
    listTools: (backend, session) =>
      withClient(backend, session, async (client) => (await client.listTools(undefined, { timeout: timeoutMs })).tools),
    callTool: (backend, session, name, args) =>
      withClient(
        backend,
        session,
        async (client) =>
          (await client.callTool({ name, ...(args && { arguments: args }) }, undefined, {
            timeout: timeoutMs,
          })) as CallToolResult,
      ),
  };
}
