export const FAILURE_THRESHOLD = 5;
export const OPEN_DURATION_MS = 30_000;

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface BreakerOptions {
  failureThreshold?: number;
  openMs?: number;
  now?: () => number;
}

/**
 * Closed until `failureThreshold` consecutive failures, then open for `openMs`, then one probe at a time
 * (half open). Every `tryAcquire() === true` must end in `recordSuccess`, `recordFailure` or `release`.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private probing = false;
  private readonly failureThreshold: number;
  private readonly openMs: number;
  private readonly now: () => number;

  constructor({
    failureThreshold = FAILURE_THRESHOLD,
    openMs = OPEN_DURATION_MS,
    now = Date.now,
  }: BreakerOptions = {}) {
    this.failureThreshold = failureThreshold;
    this.openMs = openMs;
    this.now = now;
  }

  get state(): BreakerState {
    if (this.openedAt === undefined) return 'closed';
    return this.probing || this.now() - this.openedAt >= this.openMs ? 'half_open' : 'open';
  }

  /** True while calls are being refused outright (open, or half open with the probe already out). */
  get refusing(): boolean {
    return this.openedAt !== undefined && (this.probing || this.now() - this.openedAt < this.openMs);
  }

  tryAcquire(): boolean {
    if (this.openedAt === undefined) return true;
    if (this.probing || this.now() - this.openedAt < this.openMs) return false;
    this.probing = true;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openedAt = undefined;
    this.probing = false;
  }

  recordFailure(): void {
    this.failures += 1;
    if (this.probing || this.failures >= this.failureThreshold) {
      this.openedAt = this.now();
      this.probing = false;
    }
  }

  /** The call never reached the backend (e.g. the token exchange failed): free a probe slot, count nothing. */
  release(): void {
    this.probing = false;
  }
}
