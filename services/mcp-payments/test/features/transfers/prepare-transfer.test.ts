import { describe, expect, it } from 'vitest';
import { prepareTransfer, type PrepareTransferArgs } from '../../../src/features/transfers/prepare-transfer.js';
import { InMemoryTransfersRepository } from '../../support/in-memory-transfers.js';

const NOW = new Date('2026-11-01T12:00:00.000Z');
const VALID: PrepareTransferArgs = {
  sourceAccountId: 'acc-juan-ars',
  beneficiaryId: 'ben-juan-ana',
  amount: 50000.5,
  currency: 'ARS',
};

async function prepare(args: Partial<PrepareTransferArgs>, customerId = 'juan') {
  const repo = new InMemoryTransfersRepository();
  const result = await prepareTransfer(repo, customerId, { ...VALID, ...args }, () => NOW);
  return { repo, result };
}

describe('prepareTransfer', () => {
  it('stores a pending draft for the customer that expires in five minutes', async () => {
    const { repo, result } = await prepare({});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.draft).toMatchObject({
      customerId: 'juan',
      sourceAccountId: 'acc-juan-ars',
      beneficiaryId: 'ben-juan-ana',
      amount: '50000.50',
      fee: '0.00',
      currency: 'ARS',
      status: 'pending',
      expiresAt: '2026-11-01T12:05:00.000Z',
    });
    expect(result.value.draft.id).toMatch(/^drf_/);
    expect(result.value.total).toBe('50000.50');
    expect(repo.drafts).toEqual([result.value.draft]);
  });

  it.each<[string, Partial<PrepareTransferArgs>, string]>([
    ["another customer's account", { sourceAccountId: 'acc-ana-ars' }, 'account_not_found'],
    ['an unknown account', { sourceAccountId: 'acc-nope' }, 'account_not_found'],
    ["another customer's beneficiary", { beneficiaryId: 'ben-ana-lucia' }, 'beneficiary_not_found'],
    ['a source account in another currency', { sourceAccountId: 'acc-juan-usd', currency: 'USD' }, 'currency_mismatch'],
    ['an amount over the per-transfer limit', { amount: 2_000_000.01 }, 'over_limit'],
    ['an amount too big for fixed notation', { amount: 1e21 }, 'over_limit'],
    ['an infinite amount', { amount: Number.POSITIVE_INFINITY }, 'over_limit'],
    ['more than the balance', { amount: 486750.26 }, 'insufficient_funds'],
  ])('rejects %s and stores nothing', async (_, args, code) => {
    const { repo, result } = await prepare(args);
    expect(result).toEqual({ ok: false, error: { code, message: expect.any(String) } });
    expect(repo.drafts).toEqual([]);
  });

  it('allows exactly the whole balance', async () => {
    const { result } = await prepare({ amount: 486750.25 });
    expect(result.ok).toBe(true);
  });

  it("does not reveal another customer's account in its message", async () => {
    const { result: theirs } = await prepare({ sourceAccountId: 'acc-ana-ars' });
    const { result: missing } = await prepare({ sourceAccountId: 'acc-nope' });
    expect(theirs).toEqual(missing);
  });
});
