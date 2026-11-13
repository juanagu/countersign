import type { ApprovalError } from './approval-decision';

export const PIN_LENGTH = 6;

export type PinEvent = { type: 'opened' } | { type: 'pin_changed' } | { type: 'failed'; error: ApprovalError };

/**
 * The dialog's error is about the PIN last sent. Reopening the dialog or editing the PIN starts over, so a
 * lockout can't keep the button disabled after it expires; the IdP still refuses while the lock lasts.
 */
export function pinErrorAfter(event: PinEvent): ApprovalError | null {
  return event.type === 'failed' ? event.error : null;
}

export function canSubmitPin(pin: string, pending: boolean, error: ApprovalError | null): boolean {
  return pin.length === PIN_LENGTH && !pending && error !== 'locked';
}
