import { describe, expect, it } from 'vitest';
import { RateLimiter, TIER_LIMITS } from '../../../src/features/proxy/rate-limiter.js';

const MINUTE = 60_000;

function setup() {
  const clock = { t: 1_000_000 };
  return { clock, limiter: new RateLimiter(TIER_LIMITS, () => clock.t) };
}

function spend(limiter: RateLimiter, customer: string, tier: 'T1' | 'T2' | 'T3', times: number) {
  for (let i = 0; i < times; i++) expect(limiter.check(customer, tier).allowed).toBe(true);
}

describe('RateLimiter', () => {
  it('has the ADR limits: T1 120 per minute, T2 20 and T3 10 per ten minutes', () => {
    expect(TIER_LIMITS).toEqual({
      T1: { max: 120, windowMs: MINUTE },
      T2: { max: 20, windowMs: 10 * MINUTE },
      T3: { max: 10, windowMs: 10 * MINUTE },
    });
  });

  it.each([
    ['T1', 120],
    ['T2', 20],
    ['T3', 10],
  ] as const)('refuses the call after %s reaches %i', (tier, max) => {
    const { limiter } = setup();
    spend(limiter, 'juan', tier, max);
    expect(limiter.check('juan', tier)).toMatchObject({ allowed: false });
  });

  it('does not limit T0', () => {
    const { limiter } = setup();
    for (let i = 0; i < 500; i++) expect(limiter.check('juan', 'T0').allowed).toBe(true);
  });

  it('keeps one bucket per customer and per tier', () => {
    const { limiter } = setup();
    spend(limiter, 'juan', 'T3', 10);
    expect(limiter.check('ana', 'T3').allowed).toBe(true);
    expect(limiter.check('juan', 'T2').allowed).toBe(true);
  });

  it('says when to come back, and lets calls through as the window slides', () => {
    const { limiter, clock } = setup();
    spend(limiter, 'juan', 'T3', 10);
    clock.t += 4 * MINUTE;
    expect(limiter.check('juan', 'T3')).toEqual({ allowed: false, retryAfterSeconds: 6 * 60 });
    clock.t += 6 * MINUTE;
    expect(limiter.check('juan', 'T3').allowed).toBe(true);
  });

  it('does not count a refused call against the customer', () => {
    const { limiter, clock } = setup();
    spend(limiter, 'juan', 'T3', 10);
    for (let i = 0; i < 50; i++) limiter.check('juan', 'T3');
    clock.t += 10 * MINUTE;
    expect(limiter.check('juan', 'T3').allowed).toBe(true);
  });
});
