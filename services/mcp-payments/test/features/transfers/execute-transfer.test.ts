import { decodeJwt } from 'jose';
import { createTestKeys, TEST_ISSUER, type TestKeys } from '@poc/mcp-kit/testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Deadline } from '../../../src/features/transfers/deadline.js';
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

/** Marks the token's `jti` spent by an attempt that moved nothing, as an `insufficient_funds` answer leaves it. */
function spendOnARejectedAttempt(token: string) {
  repo.usedJtis.set(String(decodeJwt(token).jti), DRAFT.id);
}

const deps = (now = NOW) => ({
  repo,
  verifyStepUp: createStepUpVerifier({ issuer: TEST_ISSUER, audience: 'mcp-payments', keys: keys.keys }),
  now: () => now,
});

const execute = (
  d: ReturnType<typeof deps>,
  customerId: string,
  draftId: string,
  token: string,
  deadline = Deadline.after(5000),
) => executeTransfer(d, customerId, draftId, token, deadline);

describe('executeTransfer', () => {
  it('executes a draft with a matching step-up token and returns the receipt', async () => {
    const result = await execute(deps(), 'juan', DRAFT.id, await stepUp());
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
      const result = await execute(deps(), 'juan', DRAFT.id, await stepUp(claims, grant));
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
      expect(await execute(deps(), 'juan', DRAFT.id, token)).toMatchObject({
        error: { code: 'not_authorised' },
      });
      expect(repo.debits).toEqual([]);
    });

    it('the draft expired', async () => {
      const later = new Date('2026-11-13T12:06:00.000Z');
      const result = await execute(deps(later), 'juan', DRAFT.id, await stepUp());
      expect(result).toMatchObject({ ok: false, error: { code: 'draft_expired' } });
      expect(repo.debits).toEqual([]);
    });

    it('another customer calls with their own valid token for this draft', async () => {
      const result = await execute(deps(), 'ana', DRAFT.id, await stepUp({ sub: 'ana' }));
      expect(result).toMatchObject({ ok: false, error: { code: 'draft_not_found' } });
      expect(repo.debits).toEqual([]);
    });
  });

  it('is idempotent per draft: a second, fresh token returns the same receipt without a second debit', async () => {
    const first = await execute(deps(), 'juan', DRAFT.id, await stepUp());
    const second = await execute(deps(), 'juan', DRAFT.id, await stepUp());
    expect(second).toEqual(first);
    expect(repo.debits).toHaveLength(1);
  });

  it('executes once when two confirmations race', async () => {
    const [a, b] = await Promise.all([
      execute(deps(), 'juan', DRAFT.id, await stepUp()),
      execute(deps(), 'juan', DRAFT.id, await stepUp()),
    ]);
    expect(a.ok && b.ok).toBe(true);
    expect(repo.debits).toHaveLength(1);
  });

  describe('answers a replay from the record of what happened', () => {
    const later = new Date('2026-11-13T12:06:00.000Z');

    it('gives the token that executed the draft the same receipt, and debits once', async () => {
      const token = await stepUp();
      const first = await execute(deps(), 'juan', DRAFT.id, token);
      const replay = await execute(deps(), 'juan', DRAFT.id, token);
      expect(first.ok).toBe(true);
      expect(replay).toEqual(first);
      expect(repo.debits).toHaveLength(1);
    });

    it('executes once when two calls race with one token, and neither is told the token was used', async () => {
      const token = await stepUp();
      const [a, b] = await Promise.all([
        execute(deps(), 'juan', DRAFT.id, token),
        execute(deps(), 'juan', DRAFT.id, token),
      ]);
      expect(a.ok && b.ok).toBe(true);
      expect(a).toEqual(b);
      expect(repo.debits).toHaveLength(1);
    });

    it('tells a token a rejected attempt spent that the draft is no longer pending once another token executed it', async () => {
      const stale = await stepUp();
      spendOnARejectedAttempt(stale);
      expect((await execute(deps(), 'juan', DRAFT.id, await stepUp())).ok).toBe(true);
      expect(await execute(deps(), 'juan', DRAFT.id, stale)).toMatchObject({
        ok: false,
        error: { code: 'draft_not_pending' },
      });
      expect(repo.debits).toHaveLength(1);
    });

    it('answers token_already_used only for a spent token on a draft that is still pending', async () => {
      const stale = await stepUp();
      spendOnARejectedAttempt(stale);
      expect(await execute(deps(), 'juan', DRAFT.id, stale)).toMatchObject({
        error: { code: 'token_already_used' },
      });
      expect(repo.drafts[0]?.status).toBe('pending');
      expect(repo.debits).toEqual([]);
    });

    it('answers draft_expired, not token_already_used, for a spent token on a draft that is past its expiry', async () => {
      const stale = await stepUp();
      spendOnARejectedAttempt(stale);
      expect(await execute(deps(later), 'juan', DRAFT.id, stale)).toMatchObject({
        ok: false,
        error: { code: 'draft_expired' },
      });
    });

    it('spends no token on a draft that has expired', async () => {
      await execute(deps(later), 'juan', DRAFT.id, await stepUp());
      expect(repo.usedJtis.size).toBe(0);
    });

    it('spends nothing when the source account is locked by another transfer, and says so with its own code', async () => {
      repo.accountLockHeldElsewhere = true;
      expect(await execute(deps(), 'juan', DRAFT.id, await stepUp())).toMatchObject({
        ok: false,
        error: { code: 'account_busy' },
      });
      expect(repo.usedJtis.size).toBe(0);
      expect(repo.debits).toEqual([]);
    });

    it('spends nothing when the draft is locked by another call, and fails closed with its own code', async () => {
      repo.lockHeldElsewhere = true;
      expect(await execute(deps(), 'juan', DRAFT.id, await stepUp())).toMatchObject({
        ok: false,
        error: { code: 'execution_in_progress' },
      });
      expect(repo.usedJtis.size).toBe(0);
      expect(repo.debits).toEqual([]);
    });

    it('a mismatched grant gets nothing: no receipt for an executed draft, no spent token on a pending one', async () => {
      const tampered = await stepUp({}, { amount: '1.00' });
      expect(await execute(deps(), 'juan', DRAFT.id, tampered)).toMatchObject({
        error: { code: 'not_authorised' },
      });
      expect(repo.usedJtis.size).toBe(0);
      await execute(deps(), 'juan', DRAFT.id, await stepUp());
      expect(await execute(deps(), 'juan', DRAFT.id, tampered)).toMatchObject({
        ok: false,
        error: { code: 'not_authorised' },
      });
      expect(repo.debits).toHaveLength(1);
    });
  });

  it("answers draft_not_found, and spends nothing, for a draft that does not exist or is another customer's", async () => {
    const missing = await stepUp({}, { draft_id: 'drf_missing' });
    expect(await execute(deps(), 'juan', 'drf_missing', missing)).toMatchObject({ error: { code: 'draft_not_found' } });
    expect(await execute(deps(), 'ana', DRAFT.id, await stepUp({ sub: 'ana' }))).toMatchObject({
      error: { code: 'draft_not_found' },
    });
    expect(repo.usedJtis.size).toBe(0);
    expect(repo.debits).toEqual([]);
  });

  describe('the receipt', () => {
    const expected = {
      draftId: DRAFT.id,
      amount: '50000.00',
      fee: '0.00',
      currency: 'ARS',
      sourceAccount: { id: 'acc-juan-ars', alias: 'Pesos', number: '0170-0002-7810' },
      beneficiary: { id: 'ben-juan-ana', fullName: 'Ana Gómez', bankName: 'Banco Demo' },
    };

    it('carries the account and beneficiary the card shows, on a fresh execution and on a replay', async () => {
      const token = await stepUp();
      const first = await execute(deps(), 'juan', DRAFT.id, token);
      const replay = await execute(deps(), 'juan', DRAFT.id, await stepUp());
      expect(first).toMatchObject({ ok: true, value: { receipt: expected } });
      expect(replay).toMatchObject({ ok: true, value: { receipt: expected } });
    });
  });

  describe('inside one deadline for the whole call', () => {
    const never = () => new Promise<never>(() => undefined);
    const BUDGET_MS = 60;

    async function timed<T>(run: Promise<T>) {
      const started = performance.now();
      const result = await run;
      return { result, elapsedMs: performance.now() - started };
    }

    it('answers not_executed, before anything ran, when the step-up check outlasts the budget', async () => {
      const slow = { ...deps(), verifyStepUp: never };
      const { result, elapsedMs } = await timed(
        execute(slow, 'juan', DRAFT.id, await stepUp(), Deadline.after(BUDGET_MS)),
      );
      expect(result).toMatchObject({ ok: false, error: { code: 'not_executed' } });
      expect(elapsedMs).toBeLessThan(BUDGET_MS + 200);
      expect(repo.deadlines).toEqual([]);
      expect(repo.usedJtis.size).toBe(0);
    });

    it('answers not_executed, not not_authorised, when the step-up check cannot be made', async () => {
      const unreachable = { ...deps(), verifyStepUp: () => Promise.reject(new TypeError('fetch failed')) };
      expect(await execute(unreachable, 'juan', DRAFT.id, await stepUp())).toMatchObject({
        ok: false,
        error: { code: 'not_executed' },
      });
      expect(repo.deadlines).toEqual([]);
    });

    it('hands the repository the call own deadline, not a fresh one', async () => {
      const deadline = Deadline.after(5000);
      await execute(deps(), 'juan', DRAFT.id, await stepUp(), deadline);
      expect(repo.deadlines).toEqual([deadline]);
    });

    it('lets an execution error through as it is: its outcome is unknown', async () => {
      const failure = new Error('connection terminated');
      repo.failWith = failure;
      await expect(execute(deps(), 'juan', DRAFT.id, await stepUp())).rejects.toBe(failure);
    });

    it('answers not_executed, and moves nothing, when the budget ran out before the execution', async () => {
      let elapsedMs = 0;
      const deadline = Deadline.after(1000, () => elapsedMs);
      const checked = createStepUpVerifier({ issuer: TEST_ISSUER, audience: 'mcp-payments', keys: keys.keys });
      const verifyStepUp: typeof checked = async (token) => {
        const grant = await checked(token);
        elapsedMs = 5000; // The step-up check used up the budget.
        return grant;
      };
      const result = await execute({ ...deps(), verifyStepUp }, 'juan', DRAFT.id, await stepUp(), deadline);
      expect(result).toMatchObject({ ok: false, error: { code: 'not_executed' } });
      expect(repo.debits).toEqual([]);
      expect(repo.usedJtis.size).toBe(0);
    });
  });
});
