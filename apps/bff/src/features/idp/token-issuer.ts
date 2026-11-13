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
const EXCHANGED_TOKEN_TTL_SECONDS = 5 * 60;
/** Below this, an exchanged token would expire before the caller could use it. */
export const MIN_EXCHANGED_TOKEN_TTL_SECONDS = 5;

export interface BotTokenClaims {
  sub: string;
  /** Seconds since epoch. */
  exp: number;
}

export interface ExchangedTokenRequest {
  sub: string;
  audience: string;
  scopes: readonly string[];
  /** The client acting for the user (RFC 8693 `act.sub`). */
  actor: string;
  /** Upper bound on expiry: never outlive the subject token. */
  notAfter: number;
}

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

  /**
   * Mints an audience-bound token for one downstream resource server. Returns it with its lifetime, or
   * undefined when the subject token has less than MIN_EXCHANGED_TOKEN_TTL_SECONDS left.
   */
  async issueExchanged(req: ExchangedTokenRequest): Promise<{ token: string; expiresIn: number } | undefined> {
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = Math.min(EXCHANGED_TOKEN_TTL_SECONDS, req.notAfter - now);
    if (expiresIn < MIN_EXCHANGED_TOKEN_TTL_SECONDS) return undefined;
    const token = await this.sign(
      { scope: req.scopes.join(' '), act: { sub: req.actor } },
      req.sub,
      req.audience,
      expiresIn,
    );
    return { token, expiresIn };
  }

  async verifyBotToken(token: string): Promise<BotTokenClaims> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: this.issuer,
      audience: BOT_AUDIENCE,
      algorithms: [ALG],
      requiredClaims: ['sub', 'exp'],
    });
    return { sub: payload.sub as string, exp: payload.exp as number };
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
