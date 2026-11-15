import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Catalog } from './catalog.js';
import type { CallerContext } from './request-context.js';
import type { ToolCallProxy } from './tool-call-proxy.js';

/**
 * The gateway's MCP server for one caller. It is the low-level `Server` because the catalog passes raw JSON
 * Schemas and `_meta` through, which `McpServer.registerTool` (zod schemas) can't do.
 */
export function buildGatewayServer(caller: CallerContext, catalog: Catalog, proxy: ToolCallProxy): Server {
  const server = new Server({ name: 'mcp-gateway', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await catalog.refresh(caller);
    return { tools: catalog.toolsFor(caller.principal.scopes) };
  });

  server.setRequestHandler(CallToolRequestSchema, (request) =>
    proxy.call(caller, request.params.name, request.params.arguments),
  );

  return server;
}
