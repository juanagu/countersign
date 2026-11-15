import { RISK_TIER_META_KEY, type RiskTier } from './risk-tier.js';

/** `_meta` key with the scope a caller needs to call the tool. Enforced by the gateway and the server. */
export const SCOPE_META_KEY = 'bank/scope';
/** `_meta` key with the scope a caller needs to see the tool listed; only approval-gated tools set it. */
export const LIST_SCOPE_META_KEY = 'bank/listScope';

const SCOPE_PATTERN = /^[a-z]+:[a-z]+$/;

function validScope(value: unknown): value is string {
  return typeof value === 'string' && SCOPE_PATTERN.test(value);
}

/** The one place a tool declares its tier and scopes. `listScope` defaults to `scope`. */
export function toolMeta(tier: RiskTier, scope: string, options: { listScope?: string } = {}): Record<string, unknown> {
  if (!validScope(scope) || (options.listScope !== undefined && !validScope(options.listScope))) {
    throw new Error(`Invalid tool scope: ${scope} / ${options.listScope}`);
  }
  return {
    [RISK_TIER_META_KEY]: tier,
    [SCOPE_META_KEY]: scope,
    ...(options.listScope && { [LIST_SCOPE_META_KEY]: options.listScope }),
  };
}

export function readScope(meta: Record<string, unknown> | undefined): string | undefined {
  const value = meta?.[SCOPE_META_KEY];
  return validScope(value) ? value : undefined;
}

/** A malformed `bank/listScope` yields nothing, so the tool is hidden rather than widened. */
export function readListScope(meta: Record<string, unknown> | undefined): string | undefined {
  const scope = readScope(meta);
  if (scope === undefined) return undefined;
  const listScope = meta?.[LIST_SCOPE_META_KEY];
  if (listScope === undefined) return scope;
  return validScope(listScope) ? listScope : undefined;
}
