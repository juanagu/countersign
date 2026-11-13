import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('generated contracts', () => {
  it('has an index module marked as generated', () => {
    const index = readFileSync(new URL('../src/generated/index.ts', import.meta.url), 'utf8');
    expect(index).toContain('Do not edit');
  });
});
