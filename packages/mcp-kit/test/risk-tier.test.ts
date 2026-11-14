import { describe, expect, it } from 'vitest';
import { readTier, tierMeta } from '../src/risk-tier.js';

describe('readTier', () => {
  it('reads what tierMeta wrote', () => {
    expect(readTier(tierMeta('T3'))).toBe('T3');
  });

  it.each([undefined, {}, { 'bank/riskTier': 'T9' }, { 'bank/riskTier': 3 }, { 'bank/riskTier': 'constructor' }])(
    'returns nothing for %j',
    (meta) => {
      expect(readTier(meta)).toBeUndefined();
    },
  );
});
