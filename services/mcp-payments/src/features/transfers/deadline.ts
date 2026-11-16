/** The call did not finish inside its time budget. */
export class DeadlineExceeded extends Error {
  constructor() {
    super('the call outlasted its time budget');
  }
}

/**
 * One call's time budget, started at its top and handed to every step, so verifying the token, reading the draft,
 * executing it and shaping the receipt share it instead of each having a limit of its own (ADR 023).
 */
export class Deadline {
  private constructor(
    private readonly at: number,
    private readonly clock: () => number,
  ) {}

  static after(budgetMs: number, clock: () => number = () => performance.now()): Deadline {
    return new Deadline(clock() + budgetMs, clock);
  }

  /** Whole milliseconds left, never negative. */
  remainingMs(): number {
    return Math.max(0, Math.floor(this.at - this.clock()));
  }

  /**
   * Rejects with `DeadlineExceeded` when `work` is still running after `capMs` or what is left of the budget,
   * whichever is shorter. It does not cancel `work`: use it only for steps that change nothing.
   */
  async bound<T>(work: Promise<T>, capMs = Number.POSITIVE_INFINITY): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceeded()), Math.min(capMs, this.remainingMs()));
    });
    work.catch(() => undefined); // A step that fails after the deadline passed is not an unhandled rejection.
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer);
    }
  }
}
