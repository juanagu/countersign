import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fail, ok, requireScope, tierMeta, type Principal } from '@poc/mcp-kit';
import { z } from 'zod';
import { DOMESTIC_TRANSFER_FEE, DRAFT_TTL_MS, fromCents, toCents, TRANSFER_LIMITS } from './transfer-rules.js';
import type { Beneficiary, TransfersRepository } from './transfers-repository.js';

export const SCOPES = { readBeneficiaries: 'beneficiaries:read', prepare: 'transfers:prepare' } as const;

const id = z.string().min(1).max(64);
const currency = z.enum(['ARS', 'USD']);
/** At most two decimals, positive. */
const amount = z.number().positive().multipleOf(0.01);

const mask = (value: string) => `****${value.slice(-4)}`;

function publicBeneficiary({ id, fullName, bankName, accountRef, currency }: Beneficiary) {
  return { id, name: fullName, bank: bankName, account: mask(accountRef), currency };
}

export interface TransferToolsDeps {
  repo: TransfersRepository;
  now?: () => Date;
}

export function buildPaymentsServer(
  principal: Principal,
  { repo, now = () => new Date() }: TransferToolsDeps,
): McpServer {
  const server = new McpServer({ name: 'mcp-payments', version: '0.1.0' });

  server.registerTool(
    'list_beneficiaries',
    {
      description: "Lists the customer's saved beneficiaries (people they can transfer to).",
      annotations: { readOnlyHint: true },
      _meta: tierMeta('T1'),
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
      _meta: tierMeta('T2'),
    },
    async (args) => {
      const scopeError = requireScope(principal.scopes, SCOPES.prepare);
      if (scopeError) return scopeError;
      const [account, beneficiary] = await Promise.all([
        repo.findAccount(args.source_account_id),
        repo.findBeneficiary(args.beneficiary_id),
      ]);
      if (account?.customerId !== principal.sub)
        return fail('account_not_found', 'No encontré esa cuenta entre las tuyas.');
      if (beneficiary?.customerId !== principal.sub) {
        return fail('beneficiary_not_found', 'No encontré ese destinatario entre tus contactos guardados.');
      }
      if (account.currency !== args.currency || beneficiary.currency !== args.currency) {
        return fail('currency_mismatch', 'La moneda no coincide con la cuenta de origen o la del destinatario.');
      }
      const amountCents = toCents(args.amount.toFixed(2));
      if (amountCents > BigInt(TRANSFER_LIMITS[args.currency]) * 100n) {
        return fail(
          'over_limit',
          `El monto supera el límite por transferencia (${TRANSFER_LIMITS[args.currency]} ${args.currency}).`,
        );
      }
      const fee = DOMESTIC_TRANSFER_FEE;
      if (amountCents + toCents(fee) > toCents(account.balance)) {
        return fail('insufficient_funds', 'El saldo disponible no alcanza para esta transferencia.');
      }
      const draft = {
        id: `drf_${randomUUID()}`,
        customerId: principal.sub,
        sourceAccountId: account.id,
        beneficiaryId: beneficiary.id,
        amount: fromCents(amountCents),
        fee,
        currency: args.currency,
        status: 'pending' as const,
        expiresAt: new Date(now().getTime() + DRAFT_TTL_MS).toISOString(),
      };
      await repo.createDraft(draft);
      return ok({
        draft_id: draft.id,
        status: draft.status,
        amount: draft.amount,
        fee: draft.fee,
        total: fromCents(amountCents + toCents(fee)),
        currency: draft.currency,
        source_account: { id: account.id, alias: account.alias, number: mask(account.number) },
        beneficiary: publicBeneficiary(beneficiary),
        expires_at: draft.expiresAt,
      });
    },
  );

  server.registerTool(
    'execute_transfer',
    {
      description: "Executes a prepared transfer. Requires the customer's approval and a step-up token.",
      inputSchema: { draft_id: id, step_up_token: z.string().min(1).max(4096) },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      _meta: tierMeta('T3'),
    },
    // Step-up verification lands in Phase 5; until then nothing executes.
    async () => fail('not_authorised', 'La transferencia no está autorizada.'),
  );

  return server;
}
