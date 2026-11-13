import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import type { TokenIssuer } from './token-issuer.js';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const SUBJECT_TOKEN_TYPES = new Set([ACCESS_TOKEN_TYPE, 'urn:ietf:params:oauth:token-type:jwt']);

/** The most each resource server may be granted. A request can narrow it, never widen it. */
export const AUDIENCE_SCOPES: Readonly<Record<string, readonly string[]>> = {
  'mcp-accounts': ['accounts:read'],
  'mcp-payments': ['beneficiaries:read', 'transfers:prepare'],
};

export interface TokenExchangeOptions {
  issuer: TokenIssuer;
  /** client_id → secret. Only confidential clients may exchange tokens. */
  clients: Readonly<Record<string, string>>;
}

type OAuthError =
  | 'invalid_request'
  | 'invalid_client'
  | 'unsupported_grant_type'
  | 'invalid_target'
  | 'invalid_scope'
  | 'invalid_grant';

function oauthError(c: Context, error: OAuthError, status: 400 | 401 = 400) {
  return c.json({ error }, status, status === 401 ? { 'www-authenticate': 'Basic realm="idp"' } : {});
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** RFC 6749 §2.3.1: each Basic credential is form-encoded, so `+` is a space and `%XX` an escaped byte. */
function formDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value.replaceAll('+', ' '));
  } catch {
    return undefined;
  }
}

function basicCredentials(header: string | undefined): [string, string] | undefined {
  if (!header?.startsWith('Basic ')) return undefined;
  const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString();
  const colon = decoded.indexOf(':'); // The first one only: a secret may contain ':'.
  if (colon < 0) return undefined;
  const id = formDecode(decoded.slice(0, colon));
  const secret = formDecode(decoded.slice(colon + 1));
  return id === undefined || secret === undefined ? undefined : [id, secret];
}

function authenticateClient(header: string | undefined, clients: TokenExchangeOptions['clients']): string | undefined {
  const credentials = basicCredentials(header);
  if (!credentials) return undefined;
  const [id, secret] = credentials;
  // Own keys only: `in` or a plain lookup would also match Object.prototype names like `constructor`.
  if (!Object.hasOwn(clients, id)) return undefined;
  return safeEqual(secret, clients[id] ?? '') ? id : undefined;
}

function grantedScopes(audience: string, requested: string | undefined): string[] | undefined {
  const allowed = AUDIENCE_SCOPES[audience] ?? [];
  if (!requested) return [...allowed];
  const scopes = requested.split(' ').filter(Boolean);
  return scopes.every((scope) => allowed.includes(scope)) ? scopes : undefined;
}

/** RFC 8693-shaped token exchange: an `aud=bot` subject token for an audience-bound downstream token. */
export function tokenExchangeRoutes({ issuer, clients }: TokenExchangeOptions): Hono {
  const app = new Hono();

  app.post('/token', async (c) => {
    if (!c.req.header('content-type')?.startsWith('application/x-www-form-urlencoded')) {
      return oauthError(c, 'invalid_request');
    }
    const actor = authenticateClient(c.req.header('authorization'), clients);
    if (!actor) return oauthError(c, 'invalid_client', 401);

    const form = await c.req.parseBody();
    const field = (name: string) => (typeof form[name] === 'string' ? (form[name] as string) : undefined);
    if (field('grant_type') !== GRANT_TYPE) return oauthError(c, 'unsupported_grant_type');
    const subjectToken = field('subject_token');
    if (!subjectToken || !SUBJECT_TOKEN_TYPES.has(field('subject_token_type') ?? '')) {
      return oauthError(c, 'invalid_request');
    }
    const audience = field('audience') ?? '';
    if (!Object.hasOwn(AUDIENCE_SCOPES, audience)) return oauthError(c, 'invalid_target');
    const scopes = grantedScopes(audience, field('scope'));
    if (!scopes) return oauthError(c, 'invalid_scope');

    const subject = await issuer.verifyBotToken(subjectToken).catch(() => undefined);
    if (!subject) return oauthError(c, 'invalid_grant');

    const { token, expiresIn } = await issuer.issueExchanged({
      sub: subject.sub,
      audience,
      scopes,
      actor,
      notAfter: subject.exp,
    });
    return c.json({
      access_token: token,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: 'Bearer',
      expires_in: expiresIn,
      scope: scopes.join(' '),
    });
  });

  return app;
}
