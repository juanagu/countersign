import type { RiskTier } from '@poc/mcp-kit';

export interface TierLimit {
  max: number;
  windowMs: number;
}

const MINUTE_MS = 60_000;

/** Per customer, on top of the bot's per-conversation caps (ADR 014). T0 is public data and unlimited. */
export const TIER_LIMITS: Readonly<Partial<Record<RiskTier, TierLimit>>> = {
  T1: { max: 120, windowMs: MINUTE_MS },
  T2: { max: 20, windowMs: 10 * MINUTE_MS },
  T3: { max: 10, windowMs: 10 * MINUTE_MS },
};

const SWEEP_INTERVAL_MS = MINUTE_MS;

export type RateDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/** Sliding-window log, in memory: each key holds at most `max` timestamps. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private lastSweep = 0;

  constructor(
    private readonly limits: Readonly<Partial<Record<RiskTier, TierLimit>>> = TIER_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** `customer` is the token's `sub`; it must never come from tool arguments. A refused call is not counted. */
  check(customer: string, tier: RiskTier): RateDecision {
    const limit = this.limits[tier];
    if (!limit) return { allowed: true };
    const now = this.now();
    this.sweep(now);
    const key = `${tier}:${customer}`;
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < limit.windowMs);
    const oldest = recent[0];
    if (recent.length >= limit.max && oldest !== undefined) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds: Math.ceil((oldest + limit.windowMs - now) / 1000) };
    }
    recent.push(now);
    this.hits.set(key, recent);
    return { allowed: true };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    for (const [key, times] of this.hits) {
      const tier = key.slice(0, key.indexOf(':')) as RiskTier;
      const windowMs = this.limits[tier]?.windowMs ?? 0;
      if (times.every((at) => now - at >= windowMs)) this.hits.delete(key);
    }
  }
}
