import { describe, expect, it } from 'vitest';
import { readListScope, readScope, toolMeta } from '../src/tool-meta.js';

const MALFORMED = [
  undefined,
  {},
  { 'bank/scope': 7 },
  { 'bank/scope': '' },
  { 'bank/scope': 'accounts' },
  { 'bank/scope': 'Accounts:read' },
  { 'bank/scope': 'a:b c:d' },
  { 'bank/scope': 'accounts:read\n' },
];

describe('readScope', () => {
  it('reads what toolMeta wrote', () => {
    expect(readScope(toolMeta('T1', 'accounts:read'))).toBe('accounts:read');
  });

  it.each(MALFORMED)('returns nothing for %j', (meta) => {
    expect(readScope(meta)).toBeUndefined();
  });
});

describe('readListScope', () => {
  it('defaults to the call scope', () => {
    expect(readListScope(toolMeta('T1', 'accounts:read'))).toBe('accounts:read');
  });

  it('returns the list scope when declared, leaving the call scope alone', () => {
    const meta = toolMeta('T3', 'transfers:execute', { listScope: 'transfers:prepare' });
    expect(readListScope(meta)).toBe('transfers:prepare');
    expect(readScope(meta)).toBe('transfers:execute');
  });

  it.each(MALFORMED)('returns nothing without a valid call scope: %j', (meta) => {
    expect(readListScope(meta)).toBeUndefined();
  });

  it('hides a tool whose list scope is malformed instead of widening it', () => {
    expect(readListScope({ 'bank/scope': 'transfers:execute', 'bank/listScope': 'nope' })).toBeUndefined();
  });
});

describe('toolMeta', () => {
  it('refuses a malformed scope', () => {
    expect(() => toolMeta('T1', 'accounts')).toThrow();
    expect(() => toolMeta('T1', 'accounts:read', { listScope: 'x' })).toThrow();
  });
});
