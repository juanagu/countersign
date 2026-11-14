import { describe, expect, it } from 'vitest';
import {
  confirmCardState,
  isResolved,
  type ConfirmCardFacts,
} from '../../../src/features/approval/lib/confirm-card-state';

const EXPIRES = '2026-11-13T12:05:00.000Z';
const BEFORE = Date.parse(EXPIRES) - 60_000;
const AFTER = Date.parse(EXPIRES) + 60_000;

const facts = (overrides: Partial<ConfirmCardFacts> = {}): ConfirmCardFacts => ({
  interruptOpen: false,
  running: false,
  receipted: false,
  resumeFailed: false,
  expiresAt: EXPIRES,
  now: BEFORE,
  ...overrides,
});

describe('confirmCardState', () => {
  it('is pending while this draft has an open interrupt', () => {
    expect(confirmCardState(facts({ interruptOpen: true }))).toBe('pending');
  });

  it('is confirmed once the receipt exists, whatever else is true', () => {
    expect(confirmCardState(facts({ receipted: true, running: true, resumeFailed: true, now: AFTER }))).toBe(
      'confirmed',
    );
  });

  it('never claims an outcome while the agent runs, so a replay does not flash "not sent"', () => {
    expect(confirmCardState(facts({ running: true }))).toBe('waiting');
    expect(confirmCardState(facts({ running: true, now: AFTER }))).toBe('waiting');
  });

  it('is not sent when it is settled without a receipt before it expired (a cancel)', () => {
    expect(confirmCardState(facts())).toBe('not-sent');
  });

  it('is expired when settled without a receipt after it expired', () => {
    expect(confirmCardState(facts({ now: AFTER }))).toBe('expired');
  });

  it('shows the failed confirmation when the resume failed', () => {
    expect(confirmCardState(facts({ resumeFailed: true }))).toBe('resume-failed');
  });

  it('collapses the card in every state but pending and waiting', () => {
    expect(isResolved('pending')).toBe(false);
    expect(isResolved('waiting')).toBe(false);
    expect(['confirmed', 'expired', 'not-sent', 'resume-failed'].every((s) => isResolved(s as never))).toBe(true);
  });
});
