/** Risk tiers (AGENTS.md, security rule 2). The bot's tool policy enforces them; servers only declare. */
export type RiskTier = 'T0' | 'T1' | 'T2' | 'T3';

/** Key under the MCP tool `_meta` that carries the tier. Read by the bot's tool policy. */
export const RISK_TIER_META_KEY = 'bank/riskTier';

export function tierMeta(tier: RiskTier): Record<string, unknown> {
  return { [RISK_TIER_META_KEY]: tier };
}
