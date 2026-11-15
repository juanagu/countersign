import type { Principal } from '@poc/mcp-kit';
import type { Logger } from 'pino';
import { z } from 'zod';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const SECOND_MS = 1000;
/** A cached token this close to expiry is not reused: it could die on the way to the backend. */
const EXPIRY_SKEW_MS = 10 * SECOND_MS;
const EXCHANGE_TIMEOUT_MS = 5 * SECOND_MS;
const MAX_CACHED_TOKENS = 5000;

/** The error codes of RFC 6749 §5.2: the only IdP text that is ever kept, since it is a fixed vocabulary. */
const OAUTH_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
] as const;
export type OAuthErrorCode = (typeof OAUTH_ERROR_CODES)[number];

export class TokenExchangeError extends Error {
  constructor(
    message: string,
    readonly code?: OAuthErrorCode,
  ) {
    super(message);
  }
}

/** Logs a refused or failed exchange: which backend and the RFC 6749 code when the IdP sent one, never a body. */
export function logExchangeFailure(logger: Logger, backend: string, error: unknown): void {
  if (!(error instanceof TokenExchangeError)) return;
  // invalid_scope is the expected answer for a token that holds nothing this backend serves.
  const level = error.code === 'invalid_scope' ? 'info' : 'warn';
  logger[level]({ backend, oauth_error: error.code }, 'token exchange failed');
}

function oauthErrorCode(body: unknown): OAuthErrorCode | undefined {
  const value = (body as { error?: unknown } | null | undefined)?.error;
  return OAUTH_ERROR_CODES.find((code) => code === value);
}

export interface TokenExchangerOptions {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  fetch?: typeof fetch;
  now?: () => number;
}

export interface TokenExchanger {
  /** A token for `audience`, exchanged from the caller's own (`subjectToken`). Never returns the subject token. */
  tokenFor(principal: Principal, subjectToken: string, audience: string): Promise<string>;
}

const responseSchema = z.object({ access_token: z.string().min(1), expires_in: z.number().positive() });

interface CachedToken {
  token: Promise<string>;
  /** Epoch ms after which the entry is dropped. */
  expiresAt: number;
}

const formEncode = (value: string) => new URLSearchParams({ v: value }).toString().slice('v='.length);

/**
 * Exchanges the caller's `aud=mcp-gateway` token at the IdP for one backend token (ADR 017). The cache key
 * holds the inbound `jti`, `sub` and audience: a token minted for one customer is never handed to another,
 * and one inbound token gets at most one exchange per audience while it lives.
 */
export function createTokenExchanger({
  tokenUrl,
  clientId,
  clientSecret,
  fetch: doFetch = fetch,
  now = Date.now,
}: TokenExchangerOptions): TokenExchanger {
  const cache = new Map<string, CachedToken>();
  const authorization = `Basic ${Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`).toString('base64')}`;

  async function exchange(subjectToken: string, audience: string): Promise<{ token: string; ttlMs: number }> {
    const response = await doFetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization },
      body: new URLSearchParams({
        grant_type: GRANT_TYPE,
        subject_token: subjectToken,
        subject_token_type: ACCESS_TOKEN_TYPE,
        audience,
      }),
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    }).catch(() => {
      throw new TokenExchangeError('token endpoint unreachable');
    });
    // The body never goes into the message: an IdP error can echo what it was sent. Only a known code is kept.
    if (!response.ok) {
      const code = oauthErrorCode(await response.json().catch(() => undefined));
      throw new TokenExchangeError(`token endpoint answered ${response.status}`, code);
    }
    const parsed = responseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) throw new TokenExchangeError('token endpoint answered an unexpected body');
    return { token: parsed.data.access_token, ttlMs: parsed.data.expires_in * SECOND_MS };
  }

  function evictStale(): void {
    for (const [key, entry] of cache) if (entry.expiresAt <= now()) cache.delete(key);
    while (cache.size >= MAX_CACHED_TOKENS) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) return;
      cache.delete(oldest);
    }
  }

  return {
    tokenFor(principal, subjectToken, audience) {
      const key = JSON.stringify([principal.jti, principal.sub, audience]);
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.token;

      evictStale();
      const pending = exchange(subjectToken, audience);
      const token = pending.then(({ token: issued }) => issued);
      // Concurrent calls share the one exchange; a failed one is forgotten so the next call retries it.
      cache.set(key, { token, expiresAt: now() + EXCHANGE_TIMEOUT_MS });
      pending.then(
        ({ ttlMs }) => {
          const entry = cache.get(key);
          if (entry?.token === token) entry.expiresAt = now() + ttlMs - EXPIRY_SKEW_MS;
        },
        () => {
          if (cache.get(key)?.token === token) cache.delete(key);
        },
      );
      return token;
    },
  };
}
