import type { McpRequestContext, Principal } from '@poc/mcp-kit';
import type { Logger } from 'pino';
import { createAuditLog } from './audit.js';
import type { Backend } from './backends.js';
import { createBackendClient, type BackendClient } from './backend-client.js';
import { Catalog } from './catalog.js';
import { CircuitBreaker, type BreakerOptions } from './circuit-breaker.js';
import { buildGatewayServer } from './gateway-server.js';
import { RateLimiter } from './rate-limiter.js';
import { ToolCallProxy } from './tool-call-proxy.js';
import type { TokenExchanger } from './token-exchanger.js';

export interface ProxyOptions {
  backends: readonly Backend[];
  exchanger: TokenExchanger;
  logger: Logger;
  client?: BackendClient;
  limiter?: RateLimiter;
  breaker?: BreakerOptions;
}

export interface GatewayHealth {
  status: 'ok' | 'degraded' | 'unhealthy';
  backends: Record<string, 'ok' | 'open' | 'probing'>;
  conflicts: readonly string[];
}

/** One gateway: the shared catalog, breakers and limiter, and a server built per request. */
export function createProxy({ backends, exchanger, logger, client, limiter, breaker }: ProxyOptions) {
  const breakers = new Map(backends.map((backend) => [backend.name, new CircuitBreaker(breaker)]));
  const backendClient = client ?? createBackendClient();
  const catalog = new Catalog({ backends, breakers, client: backendClient, exchanger, logger });
  const proxy = new ToolCallProxy({
    catalog,
    breakers,
    limiter: limiter ?? new RateLimiter(),
    exchanger,
    client: backendClient,
    audit: createAuditLog(logger),
    logger,
  });

  return {
    buildServer: (principal: Principal, context: McpRequestContext) =>
      buildGatewayServer({ principal, ...context }, catalog, proxy),

    /** A name two backends both serve is unhealthy; an open breaker only degrades (the other backend works). */
    health(): GatewayHealth {
      const states = Object.fromEntries(
        [...breakers].map(([name, b]) => [name, b.state === 'closed' ? 'ok' : b.state === 'open' ? 'open' : 'probing']),
      ) as GatewayHealth['backends'];
      const degraded = Object.values(states).some((state) => state !== 'ok');
      const conflicts = catalog.conflicts;
      return { status: conflicts.length > 0 ? 'unhealthy' : degraded ? 'degraded' : 'ok', backends: states, conflicts };
    },
  };
}

export type Proxy = ReturnType<typeof createProxy>;
