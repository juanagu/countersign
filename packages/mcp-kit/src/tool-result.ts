import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** A successful tool result: JSON text for the model plus structured content for code. */
export function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

/** A tool error the model may explain to the user. Never says whether another customer's resource exists. */
export function fail(code: string, message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, message }) }] };
}

export function requireScope(scopes: ReadonlySet<string>, scope: string): CallToolResult | undefined {
  return scopes.has(scope) ? undefined : fail('insufficient_scope', `Missing scope ${scope}.`);
}
