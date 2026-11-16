import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fail, ok, requireScope, toolMeta, type Principal } from '@poc/mcp-kit';
import type { Logger } from 'pino';
import { z } from 'zod';
import { executeTransfer } from './execute-transfer.js';
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

async function receiptView(repo: TransfersRepository, draft: TransferDraft, receipt: TransferReceipt) {
  const [account, beneficiary] = await Promise.all([
    repo.findAccount(draft.sourceAccountId),
    repo.findBeneficiary(draft.beneficiaryId),
  ]);
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
function errorFields(error: unknown) {
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
        const result = await executeTransfer({ repo, verifyStepUp, now }, principal.sub, draft_id, step_up_token);
        if (!result.ok) return fail(result.error.code, result.error.message);
        return ok(await receiptView(repo, result.value.draft, result.value.receipt));
      } catch (error) {
        logger?.error(errorFields(error), 'execute_transfer failed');
        return fail(INTERNAL_ERROR_CODE, INTERNAL_ERROR_MESSAGE);
      }
    },
  );

  return server;
}
