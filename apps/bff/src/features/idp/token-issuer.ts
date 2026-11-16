import { randomBytes, randomUUID } from 'node:crypto';
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
import { isPastAbsoluteCap, nowSeconds, sessionExpiry } from './session-lifetime.js';

const ALG = 'ES256';
const SESSION_ID_BYTES = 24;
export const SESSION_AUDIENCE = 'bff';
export const BOT_AUDIENCE = 'bot';
export const BOT_TOKEN_TTL_SECONDS = 5 * 60;
const EXCHANGED_TOKEN_TTL_SECONDS = 5 * 60;
export const STEP_UP_TTL_SECONDS = 2 * 60;
export const STEP_UP_AUDIENCE = 'mcp-payments';
/** Below this, an exchanged token would expire before the caller could use it. */
export const MIN_EXCHANGED_TOKEN_TTL_SECONDS = 5;

/** RFC 8693 `act` claim: who acts for the subject, with the earlier actors nested inside. */
export interface ActClaim {
  sub: string;
  act?: ActClaim;
}

/** The verified claims of a token presented as the subject of an exchange. */
export interface ExchangeSubject {
  sub: string;
  /** Seconds since epoch. */
  exp: number;
  scopes: readonly string[];
  /** The session the token descends from; every token minted from a session carries it (ADR 024). */
  sid: string;
  act?: ActClaim;
}

const MAX_ACT_DEPTH = 4;

function readAct(value: unknown, depth = 0): ActClaim {
  if (typeof value !== 'object' || value === null || depth >= MAX_ACT_DEPTH) throw new Error('malformed act claim');
  const { sub, act } = value as { sub?: unknown; act?: unknown };
  if (typeof sub !== 'string' || sub === '') throw new Error('malformed act claim');
  return act === undefined ? { sub } : { sub, act: readAct(act, depth + 1) };
}

export interface ExchangedTokenRequest {
  sub: string;
  sid: string;
  audience: string;
  scopes: readonly string[];
  /** The actor chain stamped on the token: this client, with any earlier actors nested inside. */
  act: ActClaim;
  /** Upper bound on expiry: never outlive the subject token. */
  notAfter: number;
}

export interface ExchangedToken {
  token: string;
  expiresIn: number;
  jti: string;
  /** Seconds since epoch. */
  exp: number;
}

/** RAR-shaped (RFC 9396) grant for one transfer: exactly the draft the customer confirmed. */
export interface TransferAuthorization {
  type: 'transfer';
  draft_id: string;
  amount: string;
  currency: 'ARS' | 'USD';
  beneficiary_id: string;
}

export interface SessionClaims {
  sub: string;
  name: string;
  /** Opaque, random, constant across a session's re-issues: what logout revokes. */
  sid: string;
  /** Seconds since epoch of the login; the absolute cap counts from here and re-issues keep it. */
  authTime: number;
  /** Seconds since epoch. */
  exp: number;
}

/** What identifies a session across its re-issues. */
export type SessionLineage = Pick<SessionClaims, 'sid' | 'authTime'>;

export interface IssuedSession extends SessionLineage {
  token: string;
  /** Seconds since epoch. */
  exp: number;
}

const newSessionId = (): string => randomBytes(SESSION_ID_BYTES).toString('base64url');

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value !== '';

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

  /** A new session, or with `lineage` its re-issue: same `sid` and `auth_time`, a later expiry within the cap. */
  async issueSession(user: Pick<DemoUser, 'id' | 'name'>, lineage?: SessionLineage): Promise<IssuedSession> {
    const now = nowSeconds();
    const { sid, authTime } = lineage ?? { sid: newSessionId(), authTime: now };
    const exp = sessionExpiry(authTime, now);
    const claims = { name: user.name, sid, auth_time: authTime };
    const token = await this.sign(claims, user.id, SESSION_AUDIENCE, exp - now, randomUUID(), now);
    return { token, sid, authTime, exp };
  }

  /** Short-lived token the BFF forwards to the bot, so the bot never sees the session token. */
  issueBotToken(session: Pick<SessionClaims, 'sub' | 'sid'>): Promise<string> {
    return this.sign({ scope: 'chat', sid: session.sid }, session.sub, BOT_AUDIENCE, BOT_TOKEN_TTL_SECONDS);
  }

  /**
   * Mints an audience-bound token for one downstream resource server. Returns it with its lifetime, or
   * undefined when the subject token has less than MIN_EXCHANGED_TOKEN_TTL_SECONDS left.
   */
  async issueExchanged(req: ExchangedTokenRequest): Promise<ExchangedToken | undefined> {
    const now = nowSeconds();
    const expiresIn = Math.min(EXCHANGED_TOKEN_TTL_SECONDS, req.notAfter - now);
    if (expiresIn < MIN_EXCHANGED_TOKEN_TTL_SECONDS) return undefined;
    const jti = randomUUID();
    const claims = { scope: req.scopes.join(' '), act: req.act, sid: req.sid };
    const token = await this.sign(claims, req.sub, req.audience, expiresIn, jti, now);
    return { token, expiresIn, jti, exp: now + expiresIn };
  }

  /** Short-lived, single-use (by `jti`) token that authorises executing exactly one transfer draft. */
  issueStepUp(session: Pick<SessionClaims, 'sub' | 'sid'>, authorization: TransferAuthorization): Promise<string> {
    return this.sign(
      { token_use: 'step_up', scope: 'transfers:execute', authorization_details: [authorization], sid: session.sid },
      session.sub,
      STEP_UP_AUDIENCE,
      STEP_UP_TTL_SECONDS,
    );
  }

  /** Verifies a token this IdP issued for `audience`, to be exchanged for a narrower one. */
  async verifyExchangeSubject(token: string, audience: string): Promise<ExchangeSubject> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: this.issuer,
      audience,
      algorithms: [ALG],
      requiredClaims: ['sub', 'exp'],
    });
    const act = payload.act === undefined ? undefined : readAct(payload.act);
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(' ').filter(Boolean) : [];
    if (!isNonEmptyString(payload.sid)) throw new Error('token without sid');
    return { sub: payload.sub as string, exp: payload.exp as number, scopes, sid: payload.sid, ...(act && { act }) };
  }

  /** Verifies an `aud=bot` token this IdP issued; the history restore reads the session it descends from. */
  async verifyBotToken(token: string): Promise<Pick<SessionClaims, 'sub' | 'sid'>> {
    const { sub, sid } = await this.verifyExchangeSubject(token, BOT_AUDIENCE);
    return { sub, sid };
  }

  async verifySession(token: string): Promise<SessionClaims> {
    const { payload } = await jwtVerify(token, this.publicKey, {
      issuer: this.issuer,
      audience: SESSION_AUDIENCE,
      algorithms: [ALG],
      requiredClaims: ['sub', 'exp'],
    });
    const { sub, name, sid, auth_time: authTime, exp } = payload;
    if (!isNonEmptyString(sub) || typeof name !== 'string' || !isNonEmptyString(sid)) {
      throw new Error('malformed session');
    }
    if (typeof authTime !== 'number' || typeof exp !== 'number') throw new Error('malformed session');
    if (isPastAbsoluteCap(authTime, nowSeconds())) throw new Error('session past its absolute lifetime');
    return { sub, name, sid, authTime, exp };
  }

  private sign(
    claims: JWTPayload,
    sub: string,
    audience: string,
    ttlSeconds: number,
    jti: string = randomUUID(),
    issuedAt: number = nowSeconds(),
  ): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: ALG, kid: this.kid, typ: 'JWT' })
      .setIssuer(this.issuer)
      .setSubject(sub)
      .setAudience(audience)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttlSeconds)
      .setJti(jti)
      .sign(this.privateKey);
  }
}
