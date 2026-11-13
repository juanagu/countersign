import type { TransferConfirmData } from '@poc/contracts';
import { z } from 'zod';

const stepUpResponse = z.object({ step_up_token: z.string().min(1), expires_in: z.number() });

export type StepUpError = 'invalid_pin' | 'locked' | 'failed';

export class StepUpFailed extends Error {
  constructor(readonly reason: StepUpError) {
    super(reason);
  }
}

const ERRORS: Record<number, StepUpError> = { 401: 'invalid_pin', 429: 'locked' };

/** Re-authenticates with the PIN for exactly this draft; the IdP binds the token to these values. */
export async function requestStepUp(draft: TransferConfirmData, pin: string): Promise<string> {
  const res = await fetch('/api/auth/step-up', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      draft_id: draft.draftId,
      amount: draft.amount,
      currency: draft.currency,
      beneficiary_id: draft.beneficiaryId,
      pin,
    }),
  });
  if (!res.ok) throw new StepUpFailed(ERRORS[res.status] ?? 'failed');
  return stepUpResponse.parse(await res.json()).step_up_token;
}
