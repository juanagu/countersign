import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { AUDIENCE_SCOPES, CLIENT_POLICIES, type ClientPolicy } from './client-policies.js';
import type { ExchangeSubject, TokenIssuer } from './token-issuer.js';

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
const SUBJECT_TOKEN_TYPES = new Set([ACCESS_TOKEN_TYPE, 'urn:ietf:params:oauth:token-type:jwt']);

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

function grantedScopes(
  audience: string,
  requested: string | undefined,
  subject: ExchangeSubject,
  policy: ClientPolicy,
): string[] | undefined {
  const ceiling = AUDIENCE_SCOPES[audience] ?? [];
  // A downstream token never widens the subject's scopes.
  const allowed = policy.inheritSubjectScopes ? ceiling.filter((scope) => subject.scopes.includes(scope)) : ceiling;
  if (allowed.length === 0) return undefined;
  if (requested === undefined) return [...allowed];
  const scopes = [...new Set(requested.split(' ').filter(Boolean))];
  if (!scopes.every((scope) => allowed.includes(scope))) return undefined;
  const hasSolo = scopes.some((scope) => policy.soloScopes.includes(scope));
  return hasSolo && scopes.length > 1 ? undefined : scopes;
}

function sameChain(subject: ExchangeSubject, expected: readonly string[]): boolean {
  const chain: string[] = [];
  for (let act = subject.act; act; act = act.act) chain.push(act.sub);
  return chain.length === expected.length && chain.every((actor, index) => actor === expected[index]);
}

/**
 * RFC 8693-shaped token exchange: a subject token for an audience-bound downstream token. Each client
 * presents one kind of subject token and asks for a fixed set of audiences (`CLIENT_POLICIES`).
 */
export function tokenExchangeRoutes({ issuer, clients }: TokenExchangeOptions): Hono {
  const app = new Hono();

  app.post('/token', async (c) => {
    if (!c.req.header('content-type')?.startsWith('application/x-www-form-urlencoded')) {
      return oauthError(c, 'invalid_request');
    }
    const client = authenticateClient(c.req.header('authorization'), clients);
    const policy = client && Object.hasOwn(CLIENT_POLICIES, client) ? CLIENT_POLICIES[client] : undefined;
    if (!client || !policy) return oauthError(c, 'invalid_client', 401);

    const form = await c.req.parseBody();
    const field = (name: string) => (typeof form[name] === 'string' ? (form[name] as string) : undefined);
    if (field('grant_type') !== GRANT_TYPE) return oauthError(c, 'unsupported_grant_type');
    const subjectToken = field('subject_token');
    if (!subjectToken || !SUBJECT_TOKEN_TYPES.has(field('subject_token_type') ?? '')) {
      return oauthError(c, 'invalid_request');
    }
    const audience = field('audience') ?? '';
    if (!Object.hasOwn(AUDIENCE_SCOPES, audience) || !policy.targets.includes(audience)) {
      return oauthError(c, 'invalid_target');
    }

    // Present but blank is a malformed request, never a fallback to the whole ceiling.
    const requestedScope = field('scope');
    if (requestedScope !== undefined && requestedScope.trim() === '') return oauthError(c, 'invalid_request');
    if (requestedScope === undefined && policy.scopeRequired) return oauthError(c, 'invalid_request');

    const subject = await issuer.verifyExchangeSubject(subjectToken, policy.subjectAudience).catch(() => undefined);
    if (!subject || !sameChain(subject, policy.subjectActors)) return oauthError(c, 'invalid_grant');
    const scopes = grantedScopes(audience, requestedScope, subject, policy);
    if (!scopes) return oauthError(c, 'invalid_scope');

    const exchanged = await issuer.issueExchanged({
      sub: subject.sub,
      audience,
      scopes,
      act: { sub: client, ...(subject.act && { act: subject.act }) },
      notAfter: subject.exp,
    });
    if (!exchanged) return oauthError(c, 'invalid_grant'); // The subject token is about to expire.
    return c.json({
      access_token: exchanged.token,
      issued_token_type: ACCESS_TOKEN_TYPE,
      token_type: 'Bearer',
      expires_in: exchanged.expiresIn,
      scope: scopes.join(' '),
    });
  });

  return app;
}
