import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Principal } from './principal.js';

export interface JwtVerifierOptions {
  issuer: string;
  /** This server's own audience; a token for any other audience is rejected. */
  audience: string;
  /** Agents allowed to act for a customer via token exchange. */
  allowedActors: readonly string[];
  keys: JWTVerifyGetKey;
}

export class InvalidAccessTokenError extends Error {}

export type VerifyAccessToken = (token: string) => Promise<Principal>;

export function remoteJwks(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 10_000 });
}

export function createJwtVerifier({ issuer, audience, allowedActors, keys }: JwtVerifierOptions): VerifyAccessToken {
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ['ES256'],
      requiredClaims: ['exp', 'sub', 'jti'],
    }).catch((error: unknown) => {
      throw new InvalidAccessTokenError(error instanceof Error ? error.message : 'invalid token');
    });
    const actor = (payload.act as { sub?: unknown } | undefined)?.sub;
    if (typeof actor !== 'string' || !allowedActors.includes(actor)) {
      throw new InvalidAccessTokenError('token was not issued to an allowed actor');
    }
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
    return { sub: payload.sub as string, scopes: new Set(scopes), actor };
  };
}
