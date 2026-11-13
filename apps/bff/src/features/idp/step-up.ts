import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { requireSession, type SessionEnv } from './session.js';
import { STEP_UP_TTL_SECONDS, type TokenIssuer } from './token-issuer.js';

const MAX_FAILURES = 3;
const LOCKOUT_MS = 5 * 60 * 1000;

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

/** Counts wrong PINs per user; three in a row lock step-up for five minutes. */
class PinAttempts {
  private readonly failures = new Map<string, { count: number; since: number }>();

  constructor(private readonly now: () => number) {}

  locked(sub: string): boolean {
    const entry = this.failures.get(sub);
    if (!entry) return false;
    if (this.now() - entry.since > LOCKOUT_MS) {
      this.failures.delete(sub);
      return false;
    }
    return entry.count >= MAX_FAILURES;
  }

  fail(sub: string): void {
    const entry = this.failures.get(sub);
    this.failures.set(sub, entry ? { ...entry, count: entry.count + 1 } : { count: 1, since: this.now() });
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
