import { McpError, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import type { Logger } from 'pino';
import type { AuditLog, CallOutcome } from './audit.js';
import { BackendFailure, type BackendClient } from './backend-client.js';
import type { Catalog, Route } from './catalog.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import type { RateLimiter } from './rate-limiter.js';
import type { CallerContext } from './request-context.js';
import { logExchangeFailure, type TokenExchanger } from './token-exchanger.js';
import { currentTraceId, traceHeaders } from './trace-context.js';

const tracer = trace.getTracer('mcp-gateway');

export interface ToolCallProxyDeps {
  catalog: Catalog;
  breakers: ReadonlyMap<string, CircuitBreaker>;
  limiter: RateLimiter;
  exchanger: TokenExchanger;
  client: BackendClient;
  audit: AuditLog;
  logger: Logger;
  now?: () => number;
}

interface Dispatched {
  result: CallToolResult;
  outcome: CallOutcome;
  route?: Route;
}

function errorResult(body: Record<string, unknown>): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
}

/** Routes one `tools/call` to its backend. Never retries: a replay could spend a step-up `jti` or draft twice. */
export class ToolCallProxy {
  private readonly now: () => number;

  constructor(private readonly deps: ToolCallProxyDeps) {
    this.now = deps.now ?? (() => performance.now());
  }

  async call(caller: CallerContext, name: string, args: Record<string, unknown> | undefined): Promise<CallToolResult> {
    const started = this.now();
    return tracer.startActiveSpan('mcp.tool_call', async (span) => {
      let outcome: CallOutcome = 'upstream_error';
      let route: Route | undefined;
      try {
        const dispatched = await this.dispatch(caller, name, args);
        ({ outcome, route } = dispatched);
        return dispatched.result;
      } catch (error) {
        if (error instanceof McpError) outcome = 'tool_error'; // The backend's own JSON-RPC error, passed on.
        throw error;
      } finally {
        this.finish(span, caller, route, outcome, this.now() - started);
      }
    });
  }

  private async dispatch(
    caller: CallerContext,
    name: string,
    args: Record<string, unknown> | undefined,
  ): Promise<Dispatched> {
    // A narrow first caller fills only its own backends, so a missing name refreshes with this caller's token.
    let route = this.deps.catalog.route(name);
    if (!route) {
      await this.deps.catalog.refresh(caller);
      route = this.deps.catalog.route(name);
    }
    if (!route) return { result: errorResult({ error: 'unknown_tool' }), outcome: 'unknown_tool' };

    // Before the limiter: a refusal that is never forwarded is not charged.
    if (!caller.principal.scopes.has(route.scope)) {
      const body = { error: 'insufficient_scope', scope: route.scope };
      return { result: errorResult(body), outcome: 'insufficient_scope', route };
    }

    // The customer is the token's `sub`: tool arguments never name who is asking.
    const decision = this.deps.limiter.check(caller.principal.sub, route.tier);
    if (!decision.allowed) {
      const body = { error: 'rate_limited', retry_after_seconds: decision.retryAfterSeconds };
      return { result: errorResult(body), outcome: 'rate_limited', route };
    }
    const breaker = this.deps.breakers.get(route.backend.name);
    if (!breaker?.tryAcquire()) {
      return { result: this.unavailable(route, 'service_unavailable'), outcome: 'unavailable', route };
    }
    return this.forward(caller, route, name, args, breaker);
  }

  private async forward(
    caller: CallerContext,
    route: Route,
    name: string,
    args: Record<string, unknown> | undefined,
    breaker: CircuitBreaker,
  ): Promise<Dispatched> {
    try {
      const token = await this.deps.exchanger.tokenFor(caller.principal, caller.token, route.backend.audience);
      const result = await this.deps.client.callTool(
        route.backend,
        { token, headers: traceHeaders(caller.traceparent) },
        name,
        args,
      );
      breaker.recordSuccess();
      return { result, outcome: result.isError ? 'tool_error' : 'ok', route };
    } catch (error) {
      if (error instanceof McpError) {
        breaker.recordSuccess();
        throw error;
      }
      if (error instanceof BackendFailure && error.kind === 'unavailable') breaker.recordFailure();
      else if (error instanceof BackendFailure) breaker.recordSuccess();
      else {
        breaker.release();
        logExchangeFailure(this.deps.logger, route.backend.name, error);
      }
      return { result: this.unavailable(route, 'upstream_error'), outcome: 'upstream_error', route };
    }
  }

  private unavailable(route: Route, error: 'service_unavailable' | 'upstream_error'): CallToolResult {
    return errorResult({ error, service: route.backend.name });
  }

  private finish(
    span: Span,
    caller: CallerContext,
    route: Route | undefined,
    outcome: CallOutcome,
    durationMs: number,
  ) {
    span.setAttributes({
      'enduser.id': caller.principal.sub,
      'mcp.backend': route?.backend.name ?? 'none',
      'mcp.risk_tier': route?.tier ?? 'none',
      'mcp.outcome': outcome,
    });
    if (outcome === 'upstream_error') span.setStatus({ code: SpanStatusCode.ERROR });
    this.deps.audit({
      sub: caller.principal.sub,
      tool: route?.tool,
      backend: route?.backend.name,
      tier: route?.tier,
      outcome,
      durationMs,
      traceId: currentTraceId(caller.traceparent),
    });
    span.end();
  }
}
