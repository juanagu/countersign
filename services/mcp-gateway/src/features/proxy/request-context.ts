import type { McpRequestContext, Principal } from '@poc/mcp-kit';

/** Everything one inbound MCP request carries: who, the token to exchange, and the trace to continue. */
export interface CallerContext extends McpRequestContext {
  principal: Principal;
}
