import type { RiskTier } from '@poc/mcp-kit';
import type { Logger } from 'pino';

export type CallOutcome = 'ok' | 'tool_error' | 'rate_limited' | 'unavailable' | 'upstream_error' | 'unknown_tool';

/**
 * One line per `tools/call` (rule 7). The fields are the whole record: there is deliberately nowhere to put
 * arguments, results, error bodies or tokens.
 */
export interface AuditEntry {
  /** The customer's opaque id from the token, never a name. */
  sub: string;
  /** A tool name the catalog knows; undefined for an unknown name, which is caller text and stays out of logs. */
  tool: string | undefined;
  backend: string | undefined;
  tier: RiskTier | undefined;
  outcome: CallOutcome;
  durationMs: number;
  traceId: string | undefined;
}

export type AuditLog = (entry: AuditEntry) => void;

export function createAuditLog(logger: Logger): AuditLog {
  return ({ sub, tool, backend, tier, outcome, durationMs, traceId }) =>
    logger.info(
      {
        metric: 'mcp.tool_call',
        sub,
        tool,
        backend,
        tier,
        outcome,
        duration_ms: Math.round(durationMs),
        trace_id: traceId,
      },
      'tool call',
    );
}
