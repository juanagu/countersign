import { createJwtVerifier, readListScope, readScope } from '@poc/mcp-kit';
import { createTestKeys, TEST_ISSUER, type TestKeys } from '@poc/mcp-kit/testing';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AUDIENCE, createApp } from '../../../src/app.js';
import { EXECUTE_CALL_BUDGET_MS } from '../../../src/features/transfers/execute-transfer.js';
import { createStepUpVerifier } from '../../../src/features/transfers/step-up-verifier.js';
import { InMemoryTransfersRepository } from '../../support/in-memory-transfers.js';
import { connectClient, parseText } from '../../support/mcp-client.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const SCOPE = 'beneficiaries:read transfers:prepare transfers:execute';

let keys: TestKeys;
let repo: InMemoryTransfersRepository;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  keys ??= await createTestKeys();
  repo = new InMemoryTransfersRepository();
  const verify = createJwtVerifier({
    issuer: TEST_ISSUER,
    audience: AUDIENCE,
    allowedActors: ['bot'],
    keys: keys.keys,
  });
  app = createApp({
    verify,
    transfers: repo,
    verifyStepUp: createStepUpVerifier({ issuer: TEST_ISSUER, audience: AUDIENCE, keys: keys.keys }),
    now: () => NOW,
  });
});

async function clientFor(sub: string, scope = SCOPE) {
  return connectClient(app, await keys.sign({ aud: AUDIENCE, sub, scope }));
}

const juanToAna = { source_account_id: 'acc-juan-ars', beneficiary_id: 'ben-juan-ana', amount: 50000, currency: 'ARS' };

describe('mcp-payments tools', () => {
  it('declares T1 / T2 / T3 risk tiers', async () => {
    const { tools } = await (await clientFor('juan')).listTools();
    const tiers = Object.fromEntries(tools.map((t) => [t.name, t._meta?.['bank/riskTier']]));
    expect(tiers).toEqual({ list_beneficiaries: 'T1', prepare_transfer: 'T2', execute_transfer: 'T3' });
  });

  it('declares each tool its call scope, and execute_transfer a narrower list scope', async () => {
    const { tools } = await (await clientFor('juan')).listTools();
    const scopes = Object.fromEntries(tools.map((t) => [t.name, [readScope(t._meta), readListScope(t._meta)]]));
    expect(scopes).toEqual({
      list_beneficiaries: ['beneficiaries:read', 'beneficiaries:read'],
      prepare_transfer: ['transfers:prepare', 'transfers:prepare'],
      execute_transfer: ['transfers:execute', 'transfers:prepare'],
    });
  });

  it.each([
    ['list_beneficiaries', {}, 'beneficiaries:read'],
    ['prepare_transfer', juanToAna, 'transfers:prepare'],
    ['execute_transfer', { draft_id: 'd', step_up_token: 't' }, 'transfers:execute'],
  ])('%s refuses a principal holding every scope except its own', async (name, args, own) => {
    const others = SCOPE.split(' ').filter((s) => s !== own);
    const result = await (await clientFor('juan', others.join(' '))).callTool({ name, arguments: args });
    expect(parseText(result).error).toBe('insufficient_scope');
    expect(repo.drafts).toEqual([]);
  });

  it("lists only the caller's beneficiaries, masked", async () => {
    const body = parseText(await (await clientFor('juan')).callTool({ name: 'list_beneficiaries', arguments: {} }));
    expect(body.beneficiaries).toEqual([
      { id: 'ben-juan-ana', name: 'Ana Gómez', bank: 'Banco Demo', account: '••••5211', currency: 'ARS' },
      { id: 'ben-juan-pablo-usd', name: 'Pablo Ruiz', bank: 'Banco Demo', account: '••••9871', currency: 'USD' },
    ]);
  });

  it('prepares a pending draft that expires in five minutes', async () => {
    const result = await (await clientFor('juan')).callTool({ name: 'prepare_transfer', arguments: juanToAna });
    const body = parseText(result);
    expect(result.isError).toBeFalsy();
    expect(body).toMatchObject({
      status: 'pending',
      amount: '50000.00',
      fee: '0.00',
      total: '50000.00',
      currency: 'ARS',
      beneficiary: { id: 'ben-juan-ana', name: 'Ana Gómez' },
      expires_at: '2026-11-13T12:05:00.000Z',
    });
    expect(repo.drafts).toHaveLength(1);
    expect(repo.drafts[0]).toMatchObject({ id: body.draft_id, customerId: 'juan', amount: '50000.00' });
  });

  it.each([
    ["another customer's source account", { ...juanToAna, source_account_id: 'acc-ana-ars' }, 'account_not_found'],
    ["another customer's beneficiary", { ...juanToAna, beneficiary_id: 'ben-ana-lucia' }, 'beneficiary_not_found'],
    [
      'a currency that does not match',
      { ...juanToAna, source_account_id: 'acc-juan-usd', currency: 'USD' },
      'currency_mismatch',
    ],
    ['more than the balance', { ...juanToAna, amount: 486750.26 }, 'insufficient_funds'],
    // Within the schema's bound (the ARS limit) but over the USD one: the use-case answers it.
    [
      'more than the per-transfer limit',
      {
        ...juanToAna,
        source_account_id: 'acc-juan-usd',
        beneficiary_id: 'ben-juan-pablo-usd',
        amount: 10_000.01,
        currency: 'USD',
      },
      'over_limit',
    ],
  ])('refuses %s and stores nothing', async (_, args, code) => {
    const result = await (await clientFor('juan')).callTool({ name: 'prepare_transfer', arguments: args });
    expect(result.isError).toBe(true);
    expect(parseText(result).error).toBe(code);
    expect(repo.drafts).toEqual([]);
  });

  it.each([
    ['a negative amount', -10],
    ['zero', 0],
    ['fractions of a cent', 10.001],
    ['more than any currency allows', 2_000_000.01],
    ['an amount too big for fixed notation', 1e21],
  ])('rejects %s at the schema', async (_, amount) => {
    const result = await (
      await clientFor('juan')
    ).callTool({ name: 'prepare_transfer', arguments: { ...juanToAna, amount } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('Input validation error');
    expect(repo.drafts).toEqual([]);
  });

  it('refuses to prepare without the transfers:prepare scope', async () => {
    const client = await clientFor('juan', 'beneficiaries:read');
    const result = await client.callTool({ name: 'prepare_transfer', arguments: juanToAna });
    expect(parseText(result).error).toBe('insufficient_scope');
  });

  it('refuses to execute without the transfers:execute scope, even with a valid step-up token', async () => {
    const draft = parseText(
      await (await clientFor('juan')).callTool({ name: 'prepare_transfer', arguments: juanToAna }),
    );
    const stepUpToken = await keys.sign({
      aud: AUDIENCE,
      sub: 'juan',
      act: undefined,
      token_use: 'step_up',
      scope: 'transfers:execute',
      authorization_details: [
        {
          type: 'transfer',
          draft_id: draft.draft_id,
          amount: '50000.00',
          currency: 'ARS',
          beneficiary_id: 'ben-juan-ana',
        },
      ],
    });
    const client = await clientFor('juan', 'beneficiaries:read transfers:prepare');
    const result = await client.callTool({
      name: 'execute_transfer',
      arguments: { draft_id: draft.draft_id, step_up_token: stepUpToken },
    });
    expect(parseText(result).error).toBe('insufficient_scope');
    expect(repo.debits).toEqual([]);
    expect(repo.usedJtis.size).toBe(0);

    const allowed = await (
      await clientFor('juan')
    ).callTool({
      name: 'execute_transfer',
      arguments: { draft_id: draft.draft_id, step_up_token: stepUpToken },
    });
    expect(allowed.isError).toBeFalsy();
    expect(repo.debits).toHaveLength(1);
  });

  it('never executes without a valid step-up token', async () => {
    const client = await clientFor('juan');
    const result = await client.callTool({
      name: 'execute_transfer',
      arguments: { draft_id: 'drf_1', step_up_token: 'x' },
    });
    expect(parseText(result).error).toBe('not_authorised');
  });

  describe('when the execution throws', () => {
    const DRIVER_TEXT = 'duplicate key value violates unique constraint "used_jtis_pkey" Key (jti)=(secret-jti)';

    async function executeWithFailingRepo() {
      const error = Object.assign(new Error(DRIVER_TEXT), { code: '23505' });
      const logger = { error: vi.fn() } as unknown as Logger & { error: ReturnType<typeof vi.fn> };
      const failing = createApp({
        verify: createJwtVerifier({ issuer: TEST_ISSUER, audience: AUDIENCE, allowedActors: ['bot'], keys: keys.keys }),
        transfers: repo,
        verifyStepUp: createStepUpVerifier({ issuer: TEST_ISSUER, audience: AUDIENCE, keys: keys.keys }),
        now: () => NOW,
        logger,
      });
      const client = await connectClient(failing, await keys.sign({ aud: AUDIENCE, sub: 'juan', scope: SCOPE }));
      const draft = parseText(await client.callTool({ name: 'prepare_transfer', arguments: juanToAna }));
      const stepUpToken = await keys.sign({
        aud: AUDIENCE,
        sub: 'juan',
        act: undefined,
        token_use: 'step_up',
        scope: 'transfers:execute',
        authorization_details: [
          {
            type: 'transfer',
            draft_id: draft.draft_id,
            amount: '50000.00',
            currency: 'ARS',
            beneficiary_id: 'ben-juan-ana',
          },
        ],
      });
      repo.failWith = error;
      const result = await client.callTool({
        name: 'execute_transfer',
        arguments: { draft_id: draft.draft_id, step_up_token: stepUpToken },
      });
      return { result, logger, stepUpToken };
    }

    it('answers a generic internal_error that carries none of the error text', async () => {
      const { result } = await executeWithFailingRepo();
      expect(result.isError).toBe(true);
      const body = parseText(result);
      expect(body.error).toBe('internal_error');
      expect(JSON.stringify(result)).not.toMatch(/duplicate key|used_jtis|secret-jti|23505/);
    });

    it('logs the error type and driver code only, never its message', async () => {
      const { logger, stepUpToken } = await executeWithFailingRepo();
      expect(logger.error).toHaveBeenCalledTimes(1);
      const [fields, message] = logger.error.mock.calls[0] as [Record<string, unknown>, string];
      expect(fields).toEqual({ errorType: 'Error', code: '23505' });
      expect(JSON.stringify([fields, message])).not.toContain(stepUpToken);
      expect(JSON.stringify([fields, message])).not.toMatch(/duplicate key|secret-jti/);
    });
  });

  describe('around the execution', () => {
    /** Prepares a draft, runs `breakIt` (what to make fail afterwards), then executes it. */
    const executed = async (breakIt: () => void = () => undefined) => {
      const client = await clientFor('juan');
      const draft = parseText(await client.callTool({ name: 'prepare_transfer', arguments: juanToAna }));
      const stepUpToken = await keys.sign({
        aud: AUDIENCE,
        sub: 'juan',
        act: undefined,
        token_use: 'step_up',
        scope: 'transfers:execute',
        authorization_details: [
          {
            type: 'transfer',
            draft_id: draft.draft_id,
            amount: '50000.00',
            currency: 'ARS',
            beneficiary_id: 'ben-juan-ana',
          },
        ],
      });
      breakIt();
      return client.callTool({
        name: 'execute_transfer',
        arguments: { draft_id: draft.draft_id, step_up_token: stepUpToken },
      });
    };

    it('returns the receipt of a committed transfer when the account or beneficiary lookup fails afterwards', async () => {
      const result = await executed(() => {
        repo.findAccount = () => Promise.reject(new Error('connection terminated'));
      });
      expect(result.isError).toBeFalsy();
      const receipt = parseText(result);
      expect(receipt).toMatchObject({ amount: '50000.00', currency: 'ARS', reference: 'BD-TEST' });
      expect(receipt.source_account).toBeUndefined();
      expect(repo.debits).toHaveLength(1);
    });

    it('answers not_executed, a definite code, when the draft read fails before anything ran', async () => {
      const result = await executed(() => {
        repo.findDraft = () => Promise.reject(new Error('connection terminated'));
      });
      expect(result.isError).toBe(true);
      expect(parseText(result).error).toBe('not_executed');
      expect(repo.debits).toEqual([]);
      expect(repo.usedJtis.size).toBe(0);
    });

    it('answers not_executed within the call budget when the step-up check hangs', async () => {
      const hanging = createApp({
        verify: createJwtVerifier({ issuer: TEST_ISSUER, audience: AUDIENCE, allowedActors: ['bot'], keys: keys.keys }),
        transfers: repo,
        verifyStepUp: () => new Promise<never>(() => undefined),
        now: () => NOW,
      });
      const client = await connectClient(hanging, await keys.sign({ aud: AUDIENCE, sub: 'juan', scope: SCOPE }));
      const started = performance.now();
      const result = await client.callTool({
        name: 'execute_transfer',
        arguments: { draft_id: 'drf_1', step_up_token: 'x' },
      });
      expect(parseText(result).error).toBe('not_executed');
      expect(performance.now() - started).toBeLessThan(EXECUTE_CALL_BUDGET_MS);
    });
  });

  it('rejects a token minted for mcp-accounts', async () => {
    const token = await keys.sign({ aud: 'mcp-accounts', sub: 'juan', scope: SCOPE });
    await expect(connectClient(app, token)).rejects.toThrow();
  });
});
