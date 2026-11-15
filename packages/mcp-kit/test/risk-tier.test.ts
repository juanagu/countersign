import { describe, expect, it } from 'vitest';
import { readTier } from '../src/risk-tier.js';
import { toolMeta } from '../src/tool-meta.js';

describe('readTier', () => {
  it('reads what tierMeta wrote', () => {
    expect(readTier(toolMeta('T3', 'transfers:execute'))).toBe('T3');
  });

  it.each([undefined, {}, { 'bank/riskTier': 'T9' }, { 'bank/riskTier': 3 }, { 'bank/riskTier': 'constructor' }])(
    'returns nothing for %j',
    (meta) => {
      expect(readTier(meta)).toBeUndefined();
    },
  );
});
