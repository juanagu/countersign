import { createJwtVerifier } from '@poc/mcp-kit';
import { createTestKeys, TEST_ISSUER, type TestKeys } from '@poc/mcp-kit/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { AUDIENCE, createApp } from '../../../src/app.js';
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

  it("lists only the caller's beneficiaries, masked", async () => {
    const body = parseText(await (await clientFor('juan')).callTool({ name: 'list_beneficiaries', arguments: {} }));
    expect(body.beneficiaries).toEqual([
      { id: 'ben-juan-ana', name: 'Ana Gómez', bank: 'Banco Demo', account: '****5211', currency: 'ARS' },
      { id: 'ben-juan-pablo-usd', name: 'Pablo Ruiz', bank: 'Banco Demo', account: '****9871', currency: 'USD' },
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

  it('rejects a token minted for mcp-accounts', async () => {
    const token = await keys.sign({ aud: 'mcp-accounts', sub: 'juan', scope: SCOPE });
    await expect(connectClient(app, token)).rejects.toThrow();
  });
});
