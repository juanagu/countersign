import { describe, expect, it } from 'vitest';
import { fromCents, toCents } from '../../../src/features/transfers/transfer-rules.js';

describe('money in cents', () => {
  it.each([
    ['50000.00', 5000000n],
    ['0.1', 10n],
    ['486750.25', 48675025n],
    ['-12.34', -1234n],
  ])('%s ↔ %s cents', (decimal, cents) => {
    expect(toCents(decimal)).toBe(cents);
    expect(toCents(fromCents(cents))).toBe(cents);
  });
});
