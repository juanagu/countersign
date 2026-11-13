import { randomUUID } from 'node:crypto';
import { DOMESTIC_TRANSFER_FEE, DRAFT_TTL_MS, fromCents, toCents, TRANSFER_LIMITS } from './transfer-rules.js';
import type {
  Beneficiary,
  Currency,
  SourceAccount,
  TransferDraft,
  TransfersRepository,
} from './transfers-repository.js';

export interface PrepareTransferArgs {
  sourceAccountId: string;
  beneficiaryId: string;
  /** Positive, at most two decimals (the tool's schema checks it). */
  amount: number;
  currency: Currency;
}

export type PrepareTransferErrorCode =
  'account_not_found' | 'beneficiary_not_found' | 'currency_mismatch' | 'over_limit' | 'insufficient_funds';

/** A rule the request broke. The message is for the customer and never says whether another's resource exists. */
export interface PrepareTransferError {
  code: PrepareTransferErrorCode;
  message: string;
}

export interface PreparedTransfer {
  draft: TransferDraft;
  /** Amount plus fee, two decimals. */
  total: string;
  account: SourceAccount;
  beneficiary: Beneficiary;
}

export type PrepareTransferResult = { ok: true; value: PreparedTransfer } | { ok: false; error: PrepareTransferError };

const failure = (code: PrepareTransferErrorCode, message: string): PrepareTransferResult => ({
  ok: false,
  error: { code, message },
});

function checkAmount(account: SourceAccount, args: PrepareTransferArgs, amountCents: bigint) {
  const limit = TRANSFER_LIMITS[args.currency];
  if (amountCents > BigInt(limit) * 100n) {
    return failure('over_limit', `El monto supera el límite por transferencia (${limit} ${args.currency}).`);
  }
  if (amountCents + toCents(DOMESTIC_TRANSFER_FEE) > toCents(account.balance)) {
    return failure('insufficient_funds', 'El saldo disponible no alcanza para esta transferencia.');
  }
  return undefined;
}

/** Validates a transfer for `customerId` and stores it as a pending draft; nothing moves until it is executed. */
export async function prepareTransfer(
  repo: TransfersRepository,
  customerId: string,
  args: PrepareTransferArgs,
  now: () => Date,
): Promise<PrepareTransferResult> {
  const [account, beneficiary] = await Promise.all([
    repo.findAccount(args.sourceAccountId),
    repo.findBeneficiary(args.beneficiaryId),
  ]);
  if (account?.customerId !== customerId)
    return failure('account_not_found', 'No encontré esa cuenta entre las tuyas.');
  if (beneficiary?.customerId !== customerId) {
    return failure('beneficiary_not_found', 'No encontré ese destinatario entre tus contactos guardados.');
  }
  if (account.currency !== args.currency || beneficiary.currency !== args.currency) {
    return failure('currency_mismatch', 'La moneda no coincide con la cuenta de origen o la del destinatario.');
  }
  const amountCents = toCents(args.amount.toFixed(2));
  const rejected = checkAmount(account, args, amountCents);
  if (rejected) return rejected;

  const fee = DOMESTIC_TRANSFER_FEE;
  const draft: TransferDraft = {
    id: `drf_${randomUUID()}`,
    customerId,
    sourceAccountId: account.id,
    beneficiaryId: beneficiary.id,
    amount: fromCents(amountCents),
    fee,
    currency: args.currency,
    status: 'pending',
    expiresAt: new Date(now().getTime() + DRAFT_TTL_MS).toISOString(),
  };
  await repo.createDraft(draft);
  return { ok: true, value: { draft, total: fromCents(amountCents + toCents(fee)), account, beneficiary } };
}
