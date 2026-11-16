import type { Currency, TransferDraft } from './transfers-repository.js';

export const DRAFT_TTL_MS = 5 * 60 * 1000;

/** Per-transfer limits for the POC (the knowledge base states the same figures). */
export const TRANSFER_LIMITS: Record<Currency, number> = { ARS: 2_000_000, USD: 10_000 };

/** Domestic transfers between Argentine banks are free; the fee field is there for other products. */
export const DOMESTIC_TRANSFER_FEE = '0.00';

/** Money is handled as integer cents to avoid floating-point drift. */
export function toCents(decimal: string): bigint {
  const [whole = '0', fraction = ''] = decimal.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0').slice(0, 2)) * (whole.startsWith('-') ? -1n : 1n);
}

export function fromCents(cents: bigint): string {
  const sign = cents < 0n ? '-' : '';
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}

/** What a step-up token authorises: one transfer's amount, currency and beneficiary. */
export interface AuthorisedTransfer {
  amount: string;
  currency: string;
  beneficiaryId: string;
}

/** Whether the grant covers exactly this draft. Evaluated by the repository on the draft row it locked. */
export function grantMatchesDraft(
  draft: Pick<TransferDraft, 'amount' | 'currency' | 'beneficiaryId'>,
  authorised: AuthorisedTransfer,
): boolean {
  return (
    draft.amount === authorised.amount &&
    draft.currency === authorised.currency &&
    draft.beneficiaryId === authorised.beneficiaryId
  );
}
