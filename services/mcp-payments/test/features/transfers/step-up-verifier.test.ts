import { createLocalJWKSet, errors, type JWTVerifyGetKey } from 'jose';
import { createTestKeys, TEST_ISSUER, type TestKeys } from '@poc/mcp-kit/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { createStepUpVerifier } from '../../../src/features/transfers/step-up-verifier.js';

const AUDIENCE = 'mcp-payments';
const CLAIMS = {
  aud: AUDIENCE,
  sub: 'juan',
  token_use: 'step_up',
  scope: 'transfers:execute',
  authorization_details: [
    { type: 'transfer', draft_id: 'drf_1', amount: '10.00', currency: 'ARS', beneficiary_id: 'ben-juan-ana' },
  ],
};

let keys: TestKeys;
let other: TestKeys;

beforeAll(async () => {
  [keys, other] = await Promise.all([createTestKeys(), createTestKeys()]);
});

const verifierWith = (getKey: JWTVerifyGetKey) =>
  createStepUpVerifier({ issuer: TEST_ISSUER, audience: AUDIENCE, keys: getKey });

describe('createStepUpVerifier', () => {
  it('returns the grant of a valid step-up token', async () => {
    const grant = await verifierWith(keys.keys)(await keys.sign(CLAIMS));
    expect(grant).toMatchObject({ sub: 'juan', authorization: { draftId: 'drf_1', amount: '10.00' } });
  });

  describe('answers undefined, a refusal of the token, when', () => {
    it.each([
      ['it is not a token at all', async () => 'x'],
      ['it is signed by another key', () => other.sign(CLAIMS)],
      ['it has expired', () => keys.sign(CLAIMS, -1)],
      ['it is for another audience', () => keys.sign({ ...CLAIMS, aud: 'mcp-accounts' })],
      ['its claims are not a step-up grant', () => keys.sign({ ...CLAIMS, token_use: undefined })],
    ])('%s', async (_, token) => {
      expect(await verifierWith(keys.keys)(await token())).toBeUndefined();
    });

    it('the IdP has no key for it', async () => {
      expect(await verifierWith(createLocalJWKSet({ keys: [] }))(await keys.sign(CLAIMS))).toBeUndefined();
    });
  });

  describe('rejects, so that nothing is said about the token, when the IdP keys cannot be read', () => {
    it.each([
      ['the fetch fails', new TypeError('fetch failed')],
      ['the fetch times out', new errors.JWKSTimeout()],
      [
        'the IdP answers with an error',
        new errors.JOSEError('Expected 200 OK from the JSON Web Key Set HTTP response'),
      ],
    ])('%s', async (_, failure) => {
      const unreachable: JWTVerifyGetKey = () => Promise.reject(failure);
      await expect(verifierWith(unreachable)(await keys.sign(CLAIMS))).rejects.toBe(failure);
    });
  });
});
