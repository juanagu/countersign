import { describe, expect, it } from 'vitest';
import { CircuitBreaker } from '../../../src/features/proxy/circuit-breaker.js';

function setup() {
  const clock = { t: 0 };
  return { clock, breaker: new CircuitBreaker({ failureThreshold: 5, openMs: 30_000, now: () => clock.t }) };
}

const fail = (breaker: CircuitBreaker, times: number) => {
  for (let i = 0; i < times; i++) {
    expect(breaker.tryAcquire()).toBe(true);
    breaker.recordFailure();
  }
};

describe('CircuitBreaker', () => {
  it('stays closed below five consecutive failures', () => {
    const { breaker } = setup();
    fail(breaker, 4);
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('counts consecutive failures only: a success resets the count', () => {
    const { breaker } = setup();
    fail(breaker, 4);
    breaker.tryAcquire();
    breaker.recordSuccess();
    fail(breaker, 4);
    expect(breaker.state).toBe('closed');
  });

  it('opens at five and refuses at once for 30 s', () => {
    const { breaker, clock } = setup();
    fail(breaker, 5);
    expect(breaker.state).toBe('open');
    clock.t = 29_999;
    expect(breaker.tryAcquire()).toBe(false);
    expect(breaker.refusing).toBe(true);
  });

  it('lets exactly one probe through after 30 s, and closes when it succeeds', () => {
    const { breaker, clock } = setup();
    fail(breaker, 5);
    clock.t = 30_000;
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false);
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('reopens for another 30 s when the probe fails', () => {
    const { breaker, clock } = setup();
    fail(breaker, 5);
    clock.t = 30_000;
    breaker.tryAcquire();
    breaker.recordFailure();
    expect(breaker.state).toBe('open');
    clock.t = 59_999;
    expect(breaker.tryAcquire()).toBe(false);
    clock.t = 60_000;
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('frees the probe slot when the call never reached the backend', () => {
    const { breaker, clock } = setup();
    fail(breaker, 5);
    clock.t = 30_000;
    breaker.tryAcquire();
    breaker.release();
    expect(breaker.tryAcquire()).toBe(true);
  });
});
