import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession, type SessionEnv } from './session.js';
import { STEP_UP_TTL_SECONDS, type TokenIssuer } from './token-issuer.js';

const MAX_FAILURES = 3;
const LOCKOUT_MS = 5 * 60 * 1000;
// Failures count only within this window from the streak's first one, so an old typo can't lock anyone out.
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const stepUpBody = z.object({
  draft_id: z.string().regex(/^drf_[0-9a-f-]{36}$/),
  amount: z.string().regex(/^[0-9]+\.[0-9]{2}$/),
  currency: z.enum(['ARS', 'USD']),
  beneficiary_id: z.string().min(1).max(64),
  pin: z.string().regex(/^[0-9]{6}$/),
});

export interface StepUpOptions {
  issuer: TokenIssuer;
  /** The mock IdP's PIN for every demo user (the brief fixes it at 123456). */
  pin: string;
  now?: () => number;
}

interface FailureStreak {
  count: number;
  startedAt: number;
  lockedUntil: number | undefined;
}

/**
 * Counts wrong PINs per user within 15 minutes of the streak's first failure; the third in that window locks
 * step-up for five minutes from that failure. A failure during the lock restarts the five minutes, never lifts it.
 */
export class PinAttempts {
  private readonly failures = new Map<string, FailureStreak>();

  constructor(private readonly now: () => number) {}

  locked(sub: string): boolean {
    const lockedUntil = this.failures.get(sub)?.lockedUntil;
    if (lockedUntil === undefined) return false;
    if (this.now() < lockedUntil) return true;
    this.failures.delete(sub);
    return false;
  }

  fail(sub: string): void {
    const now = this.now();
    const streak = this.currentStreak(sub, now) ?? { count: 0, startedAt: now, lockedUntil: undefined };
    const count = streak.count + 1;
    const lockedUntil = count >= MAX_FAILURES ? now + LOCKOUT_MS : undefined;
    this.failures.set(sub, { count, startedAt: streak.startedAt, lockedUntil });
  }

  /** The streak a new failure joins: an active lock always; otherwise none once its window or its lock is over. */
  private currentStreak(sub: string, now: number): FailureStreak | undefined {
    const streak = this.failures.get(sub);
    if (!streak) return undefined;
    if (streak.lockedUntil !== undefined) return now < streak.lockedUntil ? streak : undefined;
    return now - streak.startedAt < FAILURE_WINDOW_MS ? streak : undefined;
  }

  reset(sub: string): void {
    this.failures.delete(sub);
  }
}

function samePin(given: string, expected: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** `POST /auth/step-up`: the customer re-authenticates with their PIN to approve one transfer draft. */
export function stepUpRoutes({ issuer, pin, now = Date.now }: StepUpOptions): Hono<SessionEnv> {
  const app = new Hono<SessionEnv>();
  const attempts = new PinAttempts(now);

  app.post('/auth/step-up', requireSession(issuer), async (c) => {
    const { sub } = c.get('session');
    if (attempts.locked(sub)) return c.json({ error: 'locked' }, 429);
    const body = stepUpBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: 'invalid_request' }, 400);
    const { pin: given, ...draft } = body.data;
    // Re-checked after the await above: requests that passed the first check together may have locked it since.
    if (attempts.locked(sub)) return c.json({ error: 'locked' }, 429);
    if (!samePin(given, pin)) {
      attempts.fail(sub);
      return c.json({ error: 'invalid_pin' }, 401);
    }
    attempts.reset(sub);
    const token = await issuer.issueStepUp(sub, { type: 'transfer', ...draft });
    return c.json({ step_up_token: token, expires_in: STEP_UP_TTL_SECONDS });
  });

  return app;
}
