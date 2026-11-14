import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { chainsEqual, readActorChain } from './actor-chain.js';
import type { Principal } from './principal.js';

export interface JwtVerifierOptions {
  issuer: string;
  /** This server's own audience; a token for any other audience is rejected. */
  audience: string;
  /** Agents allowed to act directly for a customer via token exchange: each is the chain `[actor]`. */
  allowedActors?: readonly string[];
  /** Whole delegation chains accepted, outermost first. Compared exactly, so `['bot']` is not `['x', 'bot']`. */
  allowedActorChains?: readonly (readonly string[])[];
  keys: JWTVerifyGetKey;
}

export class InvalidAccessTokenError extends Error {}

export type VerifyAccessToken = (token: string) => Promise<Principal>;

export function remoteJwks(jwksUrl: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUrl), { cooldownDuration: 10_000 });
}

export function createJwtVerifier({
  issuer,
  audience,
  allowedActors = [],
  allowedActorChains = [],
  keys,
}: JwtVerifierOptions): VerifyAccessToken {
  const accepted = [...allowedActors.map((actor) => [actor]), ...allowedActorChains];
  if (accepted.length === 0) throw new Error('createJwtVerifier needs allowedActors or allowedActorChains');
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience,
      algorithms: ['ES256'],
      requiredClaims: ['exp', 'sub', 'jti'],
    }).catch((error: unknown) => {
      throw new InvalidAccessTokenError(error instanceof Error ? error.message : 'invalid token');
    });
    const actors = readActorChain(payload.act);
    if (!actors || !accepted.some((chain) => chainsEqual(chain, actors))) {
      throw new InvalidAccessTokenError('token was not issued through an allowed actor chain');
    }
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
    return {
      sub: payload.sub as string,
      scopes: new Set(scopes),
      actor: actors[0] as string,
      actors,
      jti: payload.jti as string,
      expiresAt: payload.exp as number,
    };
  };
}
