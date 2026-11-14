import { trace } from '@opentelemetry/api';

const TRACEPARENT_TRACE_ID = /^[\da-f]{2}-([\da-f]{32})-/;

/**
 * Headers that continue the caller's trace to a backend. With an OTel SDK running, the undici
 * instrumentation injects `traceparent` from the active span itself, and adding it here would duplicate it;
 * without one (tests, a bare run) the caller's own header is forwarded as it came.
 */
export function traceHeaders(incoming: string | undefined): Record<string, string> {
  const active = trace.getActiveSpan()?.spanContext();
  if (active && trace.isSpanContextValid(active)) return {};
  return incoming ? { traceparent: incoming } : {};
}

/** The trace id for an audit line: the active span's, else the one in the caller's `traceparent`. */
export function currentTraceId(incoming: string | undefined): string | undefined {
  const active = trace.getActiveSpan()?.spanContext();
  if (active && trace.isSpanContextValid(active)) return active.traceId;
  return incoming?.match(TRACEPARENT_TRACE_ID)?.[1];
}
