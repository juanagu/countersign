import { describe, expect, it } from 'vitest';
import { canSubmitPin, pinErrorAfter } from '../../../src/features/approval/lib/pin-entry';

describe('PIN entry after a lockout', () => {
  it('blocks submitting while the lockout error is shown', () => {
    const error = pinErrorAfter({ type: 'failed', error: 'locked' });
    expect(error).toBe('locked');
    expect(canSubmitPin('123456', false, error)).toBe(false);
  });

  it('starts over when the dialog reopens or the PIN changes, so an expired lock no longer blocks', () => {
    for (const event of [{ type: 'opened' }, { type: 'pin_changed' }] as const) {
      const error = pinErrorAfter(event);
      expect(error).toBeNull();
      expect(canSubmitPin('123456', false, error)).toBe(true);
    }
  });

  it('needs six digits and no request in flight', () => {
    expect(canSubmitPin('12345', false, null)).toBe(false);
    expect(canSubmitPin('123456', true, null)).toBe(false);
    expect(canSubmitPin('123456', false, 'invalid_pin')).toBe(true);
  });
});
