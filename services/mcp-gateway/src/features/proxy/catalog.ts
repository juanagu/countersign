import { readListScope, readScope, readTier, type RiskTier } from '@poc/mcp-kit';
import { McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from 'pino';
import type { Backend } from './backends.js';
import { BackendFailure, type BackendClient } from './backend-client.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { CallerContext } from './request-context.js';
import { logExchangeFailure, type TokenExchanger } from './token-exchanger.js';
import { traceHeaders } from './trace-context.js';

export interface Route {
  tool: string;
  backend: Backend;
  tier: RiskTier;
  /** The scope a caller's token needs to call the tool. */
  scope: string;
}

export interface CatalogDeps {
  backends: readonly Backend[];
  breakers: ReadonlyMap<string, CircuitBreaker>;
  client: BackendClient;
  exchanger: TokenExchanger;
  logger: Logger;
}

/**
 * The aggregated tool list. Tool names, schemas and `_meta` are copied verbatim, unprefixed. Schemas don't
 * depend on the customer, so each backend's last good list is kept to serve while it is down.
 */
export class Catalog {
  private readonly lastGood = new Map<string, Tool[]>();
  private merged: { tools: Tool[]; routes: Map<string, Route>; conflicts: string[] } = {
    tools: [],
    routes: new Map(),
    conflicts: [],
  };

  constructor(private readonly deps: CatalogDeps) {}

  /** The tools this caller's scopes let it see. The catalog itself stays unfiltered and shared. */
  toolsFor(scopes: ReadonlySet<string>): Tool[] {
    return this.merged.tools.filter((tool) => isListable(tool, scopes));
  }

  /** Tool names two backends both serve: neither is served, and the gateway reports unhealthy. */
  get conflicts(): readonly string[] {
    return this.merged.conflicts;
  }

  get loaded(): boolean {
    return this.lastGood.size > 0;
  }

  route(name: string): Route | undefined {
    return this.merged.routes.get(name);
  }

  async refresh(caller: CallerContext): Promise<void> {
    await Promise.all(this.deps.backends.map((backend) => this.refreshBackend(backend, caller)));
    this.merged = merge(this.deps.backends, this.lastGood);
  }

  private async refreshBackend(backend: Backend, caller: CallerContext): Promise<void> {
    const breaker = this.deps.breakers.get(backend.name);
    if (!breaker?.tryAcquire()) return; // Open: the last good list stands.
    try {
      const token = await this.deps.exchanger.tokenFor(caller.principal, caller.token, backend.audience);
      const tools = await this.deps.client.listTools(backend, {
        token,
        headers: traceHeaders(caller.traceparent),
      });
      breaker.recordSuccess();
      this.lastGood.set(
        backend.name,
        tools.filter((tool) => readTier(tool._meta) !== undefined && readScope(tool._meta) !== undefined),
      );
    } catch (error) {
      if (error instanceof BackendFailure && error.kind === 'unavailable') breaker.recordFailure();
      else if (error instanceof BackendFailure || error instanceof McpError)
        breaker.recordSuccess(); // It answered.
      else {
        breaker.release(); // Never reached the backend, e.g. an exchange the IdP refused with invalid_scope.
        logExchangeFailure(this.deps.logger, backend.name, error);
      }
    }
  }
}

/** Listed to a token that may list it, or call it: an execute-only token is the approved call's own. */
function isListable(tool: Tool, scopes: ReadonlySet<string>): boolean {
  const listScope = readListScope(tool._meta);
  const callScope = readScope(tool._meta);
  return (listScope !== undefined && scopes.has(listScope)) || (callScope !== undefined && scopes.has(callScope));
}

function merge(backends: readonly Backend[], lastGood: ReadonlyMap<string, Tool[]>) {
  const owners = new Map<string, Route[]>();
  for (const backend of backends) {
    for (const tool of lastGood.get(backend.name) ?? []) {
      const tier = readTier(tool._meta);
      const scope = readScope(tool._meta);
      if (tier && scope) {
        owners.set(tool.name, [...(owners.get(tool.name) ?? []), { tool: tool.name, backend, tier, scope }]);
      }
    }
  }
  const conflicts = [...owners].filter(([, routes]) => routes.length > 1).map(([name]) => name);
  const routes = new Map<string, Route>();
  const tools: Tool[] = [];
  for (const backend of backends) {
    for (const tool of lastGood.get(backend.name) ?? []) {
      const route = owners.get(tool.name)?.[0];
      if (conflicts.includes(tool.name) || !route || route.backend !== backend) continue;
      routes.set(tool.name, route);
      tools.push(tool);
    }
  }
  return { tools, routes, conflicts };
}
