import { randomUUID } from 'node:crypto';
import {
  exportJWK,
  generateKeyPair,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
  type JWTPayload,
} from 'jose';
import type { DemoUser } from './demo-users.js';

const ALG = 'ES256';
export const SESSION_AUDIENCE = 'bff';
export const BOT_AUDIENCE = 'bot';
export const SESSION_TTL_SECONDS = 30 * 60;
const BOT_TOKEN_TTL_SECONDS = 5 * 60;

export interface SessionClaims {
  sub: string;
  name: string;
}

/** The mock IdP's signing key and the tokens it issues. Keys are per process: a restart ends every session. */
export class TokenIssuer {
  private constructor(
    private readonly issuer: string,
    private readonly kid: string,
    private readonly privateKey: CryptoKey,
    private readonly publicKey: CryptoKey,
  ) {}

  static async create(issuer: string): Promise<TokenIssuer> {
    const { privateKey, publicKey } = await generateKeyPair(ALG, { extractable: true });
    return new TokenIssuer(issuer, randomUUID(), privateKey, publicKey);
  }

  async jwks(): Promise<JSONWebKeySet> {
    const jwk = await exportJWK(this.publicKey);
    return { keys: [{ ...jwk, kid: this.kid, alg: ALG, use: 'sig' }] };
  }

  issueSession(user: DemoUser): Promise<string> {
    return this.sign({ name: user.name }, user.id, SESSION_AUDIENCE, SESSION_TTL_SECONDS);
  }

  /** Short-lived token the BFF forwards to the bot, so the bot never sees the session token. */
  issueBotToken(session: SessionClaims): Promise<string> {
    return this.sign({ scope: 'chat' }, session.sub, BOT_AUDIENCE, BOT_TOKEN_TTL_SECONDS);
  }

  async verifySession(token: string): Promise<SessionClaims> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: this.issuer,
      audience: SESSION_AUDIENCE,
      algorithms: [ALG],
    });
    if (typeof payload.sub !== 'string' || typeof payload.name !== 'string') throw new Error('malformed session');
    return { sub: payload.sub, name: payload.name };
  }

  private sign(claims: JWTPayload, sub: string, audience: string, ttlSeconds: number): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: ALG, kid: this.kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setSubject(sub)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime(`${ttlSeconds}s`)
      .setJti(randomUUID())
      .sign(this.privateKey);
  }
}
