import { createTestKeys, TEST_ISSUER, type TestKeys } from '@poc/mcp-kit/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { executeTransfer } from '../../../src/features/transfers/execute-transfer.js';
import { createStepUpVerifier } from '../../../src/features/transfers/step-up-verifier.js';
import type { TransferDraft } from '../../../src/features/transfers/transfers-repository.js';
import { InMemoryTransfersRepository } from '../../support/in-memory-transfers.js';

const NOW = new Date('2026-11-13T12:00:00.000Z');
const DRAFT: TransferDraft = {
  id: 'drf_0b3a6f9e-4c1d-4e2a-9f7b-1a2b3c4d5e6f',
  customerId: 'juan',
  sourceAccountId: 'acc-juan-ars',
  beneficiaryId: 'ben-juan-ana',
  amount: '50000.00',
  fee: '0.00',
  currency: 'ARS',
  status: 'pending',
  expiresAt: '2026-11-13T12:05:00.000Z',
};
const GRANT = {
  type: 'transfer',
  draft_id: DRAFT.id,
  amount: DRAFT.amount,
  currency: DRAFT.currency,
  beneficiary_id: DRAFT.beneficiaryId,
};

let keys: TestKeys;
let repo: InMemoryTransfersRepository;

beforeAll(async () => {
  keys = await createTestKeys();
});

beforeEach(() => {
  repo = new InMemoryTransfersRepository();
  repo.drafts.push({ ...DRAFT });
});

function stepUp(overrides: Record<string, unknown> = {}, grant: Record<string, unknown> = {}) {
  return keys.sign({
    aud: 'mcp-payments',
    sub: 'juan',
    token_use: 'step_up',
    scope: 'transfers:execute',
    act: undefined,
    authorization_details: [{ ...GRANT, ...grant }],
    ...overrides,
  });
}

const deps = (now = NOW) => ({
  repo,
  verifyStepUp: createStepUpVerifier({ issuer: TEST_ISSUER, audience: 'mcp-payments', keys: keys.keys }),
  now: () => now,
});

describe('executeTransfer', () => {
  it('executes a draft with a matching step-up token and returns the receipt', async () => {
    const result = await executeTransfer(deps(), 'juan', DRAFT.id, await stepUp());
    expect(result.ok).toBe(true);
    expect(repo.debits).toEqual([{ draftId: DRAFT.id, amount: '50000.00' }]);
  });

  describe('rejects, and moves no money, when', () => {
    it.each([
      ['the authorised amount was tampered with', {}, { amount: '1.00' }, 'not_authorised'],
      ['the authorised beneficiary differs', {}, { beneficiary_id: 'ben-ana-lucia' }, 'not_authorised'],
      [
        'the token is for another draft',
        {},
        { draft_id: 'drf_ffffffff-ffff-ffff-ffff-ffffffffffff' },
        'not_authorised',
      ],
      ["the token is another user's", { sub: 'ana' }, {}, 'not_authorised'],
      ['the token is an access token, not a step-up', { token_use: undefined }, {}, 'not_authorised'],
      ['the token is for another audience', { aud: 'mcp-accounts' }, {}, 'not_authorised'],
      ['the step-up token has no scope', { scope: undefined }, {}, 'not_authorised'],
      ['the step-up token lacks transfers:execute', { scope: 'transfers:prepare' }, {}, 'not_authorised'],
    ])('%s', async (_, claims, grant, code) => {
      const result = await executeTransfer(deps(), 'juan', DRAFT.id, await stepUp(claims, grant));
      expect(result).toMatchObject({ ok: false, error: { code } });
      expect(repo.debits).toEqual([]);
    });

    it('the step-up token expired', async () => {
      const token = await keys.sign(
        {
          aud: 'mcp-payments',
          sub: 'juan',
          token_use: 'step_up',
          scope: 'transfers:execute',
          authorization_details: [GRANT],
        },
        -1,
      );
      expect(await executeTransfer(deps(), 'juan', DRAFT.id, token)).toMatchObject({
        error: { code: 'not_authorised' },
      });
      expect(repo.debits).toEqual([]);
    });

    it('the draft expired', async () => {
      const later = new Date('2026-11-13T12:06:00.000Z');
      const result = await executeTransfer(deps(later), 'juan', DRAFT.id, await stepUp());
      expect(result).toMatchObject({ ok: false, error: { code: 'draft_expired' } });
      expect(repo.debits).toEqual([]);
    });

    it('the draft expired while the execution waited on its row lock', async () => {
      // The first read passes the pre-check; the repository reads the clock again once it holds the lock.
      const reads = [NOW, new Date('2026-11-13T12:06:00.000Z')];
      const clock = () => reads.shift() ?? new Date('2026-11-13T12:06:00.000Z');
      const result = await executeTransfer({ ...deps(), now: clock }, 'juan', DRAFT.id, await stepUp());
      expect(result).toMatchObject({ ok: false, error: { code: 'draft_expired' } });
      expect(repo.debits).toEqual([]);
    });

    it('the same token is used twice (the double click)', async () => {
      const token = await stepUp();
      expect((await executeTransfer(deps(), 'juan', DRAFT.id, token)).ok).toBe(true);
      expect(await executeTransfer(deps(), 'juan', DRAFT.id, token)).toMatchObject({
        error: { code: 'token_already_used' },
      });
      expect(repo.debits).toHaveLength(1);
    });

    it('another customer calls with their own valid token for this draft', async () => {
      const result = await executeTransfer(deps(), 'ana', DRAFT.id, await stepUp({ sub: 'ana' }));
      expect(result).toMatchObject({ ok: false, error: { code: 'draft_not_found' } });
      expect(repo.debits).toEqual([]);
    });
  });

  it('is idempotent per draft: a second, fresh token returns the same receipt without a second debit', async () => {
    const first = await executeTransfer(deps(), 'juan', DRAFT.id, await stepUp());
    const second = await executeTransfer(deps(), 'juan', DRAFT.id, await stepUp());
    expect(second).toEqual(first);
    expect(repo.debits).toHaveLength(1);
  });

  it('executes once when two confirmations race', async () => {
    const [a, b] = await Promise.all([
      executeTransfer(deps(), 'juan', DRAFT.id, await stepUp()),
      executeTransfer(deps(), 'juan', DRAFT.id, await stepUp()),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(repo.debits).toHaveLength(1);
  });
});
