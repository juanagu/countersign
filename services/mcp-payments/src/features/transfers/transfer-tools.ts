import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fail, ok, requireScope, toolMeta, type Principal } from '@poc/mcp-kit';
import type { Logger } from 'pino';
import { z } from 'zod';
import { Deadline } from './deadline.js';
import {
  EXECUTE_CALL_BUDGET_MS,
  executeTransfer,
  NOT_EXECUTED_CODE,
  NOT_EXECUTED_MESSAGE,
  NotExecutedError,
} from './execute-transfer.js';
import { prepareTransfer, type PreparedTransfer } from './prepare-transfer.js';
import { STEP_UP_SCOPE, type VerifyStepUp } from './step-up-verifier.js';
import { TRANSFER_LIMITS } from './transfer-rules.js';
import type { Beneficiary, TransferDraft, TransferReceipt, TransfersRepository } from './transfers-repository.js';

export const SCOPES = {
  readBeneficiaries: 'beneficiaries:read',
  prepare: 'transfers:prepare',
  execute: STEP_UP_SCOPE,
} as const;

const id = z.string().min(1).max(64);
const currency = z.enum(['ARS', 'USD']);
/** At most two decimals, positive, and no more than the highest limit, so it always converts to cents. */
const amount = z
  .number()
  .positive()
  .max(Math.max(...Object.values(TRANSFER_LIMITS)))
  .multipleOf(0.01);

// Bullets, not asterisks: the model quotes this in markdown, where `**` would open bold.
const mask = (value: string) => `••••${value.slice(-4)}`;

function publicBeneficiary({ id, fullName, bankName, accountRef, currency }: Beneficiary) {
  return { id, name: fullName, bank: bankName, account: mask(accountRef), currency };
}

function draftView({ draft, total, account, beneficiary }: PreparedTransfer) {
  return {
    draft_id: draft.id,
    status: draft.status,
    amount: draft.amount,
    fee: draft.fee,
    total,
    currency: draft.currency,
    source_account: { id: account.id, alias: account.alias, number: mask(account.number) },
    beneficiary: publicBeneficiary(beneficiary),
    expires_at: draft.expiresAt,
  };
}

/** The receipt lookup after a commit gets no more than this: the money has moved, the card is a courtesy. */
const RECEIPT_LOOKUP_CAP_MS = 1000;

/**
 * The receipt of a committed execution. The account and beneficiary only decorate it, so when their lookup fails or
 * is slow the receipt goes out without them: it never turns a transfer that moved money into an error.
 */
async function receiptView(repo: TransfersRepository, draft: TransferDraft, receipt: TransferReceipt, logger?: Logger) {
  const deadline = Deadline.after(RECEIPT_LOOKUP_CAP_MS);
  const [account, beneficiary] = await deadline
    .bound(Promise.all([repo.findAccount(draft.sourceAccountId), repo.findBeneficiary(draft.beneficiaryId)]))
    .catch((error: unknown) => {
      logger?.warn(errorFields(error), 'receipt lookup failed after a committed execute_transfer');
      return [undefined, undefined] as const;
    });
  return {
    transfer_id: receipt.transferId,
    draft_id: receipt.draftId,
    reference: receipt.reference,
    executed_at: receipt.executedAt,
    amount: draft.amount,
    fee: draft.fee,
    currency: draft.currency,
    source_account: account && { id: account.id, alias: account.alias, number: mask(account.number) },
    beneficiary: beneficiary && publicBeneficiary(beneficiary),
  };
}

/**
 * What the model sees when `execute_transfer` throws: a fixed message, never the error's text (a driver's
 * message can carry SQL and row values). The execution may or may not have committed, so it says so.
 */
export const INTERNAL_ERROR_CODE = 'internal_error';
const INTERNAL_ERROR_MESSAGE =
  'No pude confirmar si la transferencia se realizó. Confirmá de nuevo con tu PIN en unos segundos: si ya se hizo, vas a recibir el mismo comprobante.';

export interface TransferToolsDeps {
  repo: TransfersRepository;
  verifyStepUp: VerifyStepUp;
  now?: () => Date;
  logger?: Logger;
}

/** Only the error's type and a driver code: its message can echo SQL, ids or amounts. */
function errorFields(error: unknown): Record<string, string> {
  if (error instanceof NotExecutedError) return errorFields(error.cause);
  const code = (error as { code?: unknown } | null)?.code;
  return { errorType: error instanceof Error ? error.name : typeof error, ...(typeof code === 'string' && { code }) };
}

export function buildPaymentsServer(
  principal: Principal,
  { repo, verifyStepUp, now = () => new Date(), logger }: TransferToolsDeps,
): McpServer {
  const server = new McpServer({ name: 'mcp-payments', version: '0.1.0' });

  server.registerTool(
    'list_beneficiaries',
    {
      description: "Lists the customer's saved beneficiaries (people they can transfer to).",
      annotations: { readOnlyHint: true },
      _meta: toolMeta('T1', SCOPES.readBeneficiaries),
    },
    async () =>
      requireScope(principal.scopes, SCOPES.readBeneficiaries) ??
      ok({ beneficiaries: (await repo.listBeneficiaries(principal.sub)).map(publicBeneficiary) }),
  );

  server.registerTool(
    'prepare_transfer',
    {
      description:
        'Prepares (does not execute) a transfer to a saved beneficiary and returns a draft valid for 5 minutes. ' +
        'The customer must confirm it in the app before anything moves.',
      inputSchema: { source_account_id: id, beneficiary_id: id, amount, currency },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      _meta: toolMeta('T2', SCOPES.prepare),
    },
    async (args) => {
      const scopeError = requireScope(principal.scopes, SCOPES.prepare);
      if (scopeError) return scopeError;
      const result = await prepareTransfer(
        repo,
        principal.sub,
        {
          sourceAccountId: args.source_account_id,
          beneficiaryId: args.beneficiary_id,
          amount: args.amount,
          currency: args.currency,
        },
        now,
      );
      return result.ok ? ok(draftView(result.value)) : fail(result.error.code, result.error.message);
    },
  );

  server.registerTool(
    'execute_transfer',
    {
      description: "Executes a prepared transfer. Requires the customer's approval and a step-up token.",
      inputSchema: { draft_id: id, step_up_token: z.string().min(1).max(4096) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      _meta: toolMeta('T3', SCOPES.execute, { listScope: SCOPES.prepare }),
    },
    async ({ draft_id, step_up_token }) => {
      // Checked before the step-up token, so a caller without the scope can't spend its jti.
      const scopeError = requireScope(principal.scopes, SCOPES.execute);
      if (scopeError) return scopeError;
      try {
        const deadline = Deadline.after(EXECUTE_CALL_BUDGET_MS);
        const result = await executeTransfer(
          { repo, verifyStepUp, now },
          principal.sub,
          draft_id,
          step_up_token,
          deadline,
        );
        if (!result.ok) return fail(result.error.code, result.error.message);
        return ok(await receiptView(repo, result.value.draft, result.value.receipt, logger));
      } catch (error) {
        logger?.error(errorFields(error), 'execute_transfer failed');
        // Nothing ran before the execution: a definite answer, the draft stays open and no execution is in flight.
        if (error instanceof NotExecutedError) return fail(NOT_EXECUTED_CODE, NOT_EXECUTED_MESSAGE);
        return fail(INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE);
      }
    },
  );

  return server;
}
