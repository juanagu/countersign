// Test-only helpers: a local signing key and token minting, so server tests need no IdP.
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export const TEST_ISSUER = 'http://idp.test';

export interface TestKeys {
  keys: JWTVerifyGetKey;
  sign: (claims: JWTPayload & { aud: string; sub?: string }, ttlSeconds?: number) => Promise<string>;
}

export async function createTestKeys(): Promise<TestKeys> {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'ES256' };
  return {
    keys: createLocalJWKSet({ keys: [jwk] }),
    sign: ({ aud, sub = 'ana', ...claims }, ttlSeconds = 300) =>
      new SignJWT({ act: { sub: 'bot' }, ...claims })
        .setProtectedHeader({ alg: 'ES256', kid: 'test' })
        .setIssuer(TEST_ISSUER)
        .setAudience(aud)
        .setSubject(sub)
        .setIssuedAt()
        .setJti(crypto.randomUUID())
        .setExpirationTime(Math.floor(Date.now() / 1000) + ttlSeconds)
        .sign(privateKey),
  };
}
