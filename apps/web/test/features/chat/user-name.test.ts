import { describe, expect, it } from 'vitest';
import { firstName, initials } from '../../../src/features/chat/lib/user-name';

describe('user name helpers', () => {
  it('takes the first word as the first name', () => {
    expect(firstName('Ana Gómez')).toBe('Ana');
    expect(firstName('  Juan  ')).toBe('Juan');
    expect(firstName('')).toBe('');
  });

  it('builds up to two initials', () => {
    expect(initials('Ana Gómez')).toBe('AG');
    expect(initials('juan carlos pérez')).toBe('JC');
    expect(initials('Ana')).toBe('A');
    expect(initials('')).toBe('');
  });
});
