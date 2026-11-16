import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createJwtVerifier } from '@poc/mcp-kit';
import { createLocalJWKSet, decodeJwt } from 'jose';
import { Hono } from 'hono';
import { pino } from 'pino';
import { tokenExchangeRoutes } from '../../../../apps/bff/src/features/idp/token-exchange.js';
import { MemoryRevocationStore } from '../../../../apps/bff/src/features/idp/revocation-store.js';
import { TokenIssuer } from '../../../../apps/bff/src/features/idp/token-issuer.js';

/** The gateway never reads `sid`; the tokens it sees carry one, as the IdP always issues them. */
export const SESSION_ID = 'sid-gateway-tests';
import {
  ALLOWED_ACTOR_CHAINS as ACCOUNTS_CHAINS,
  createApp as createAccountsApp,
} from '../../../mcp-accounts/src/app.js';
import { InMemoryAccountsRepository } from '../../../mcp-accounts/test/support/in-memory-accounts.js';
import {
  ALLOWED_ACTOR_CHAINS as PAYMENTS_CHAINS,
  createApp as createPaymentsApp,
} from '../../../mcp-payments/src/app.js';
import { createStepUpVerifier } from '../../../mcp-payments/src/features/transfers/step-up-verifier.js';
import { InMemoryTransfersRepository } from '../../../mcp-payments/test/support/in-memory-transfers.js';
import { ALLOWED_ACTORS, AUDIENCE, createApp } from '../../src/app.js';
import type { Backend } from '../../src/features/proxy/backends.js';
import { createBackendClient } from '../../src/features/proxy/backend-client.js';
import { createProxy, type ProxyOptions } from '../../src/features/proxy/proxy.js';
import { createTokenExchanger } from '../../src/features/proxy/token-exchanger.js';

export const ISSUER = 'http://idp.test';
export const BOT_SECRET = 'test-bot-secret-0123456789';
export const GATEWAY_SECRET = 'test-gateway-secret-0123456789';

export const PRE_APPROVAL_SCOPES = 'accounts:read beneficiaries:read transfers:prepare';

export const BACKENDS: Backend[] = [
  { name: 'accounts', audience: 'mcp-accounts', url: 'http://accounts.test/mcp' },
  { name: 'payments', audience: 'mcp-payments', url: 'http://payments.test/mcp' },
];

export interface SeenRequest {
  host: string;
  authorization: string | null;
  traceparent: string | null;
  body: string;
}

export interface StackOptions {
  /** Hosts whose requests fail like an unreachable server. */
  down?: Set<string>;
  /** Overrides what a host answers, to make a backend misbehave. */
  intercept?: (
    host: string,
    request: Request,
    forward: () => Promise<Response>,
  ) => Response | undefined | Promise<Response | undefined>;
  proxy?: Partial<Omit<ProxyOptions, 'backends' | 'exchanger' | 'logger'>>;
  backends?: Backend[];
  logger?: ProxyOptions['logger'];
}

/**
 * The gateway wired in-process in front of the real mcp-accounts and mcp-payments apps, with the real IdP
 * token-exchange routes. Every hop runs its real verification; only the network is replaced.
 */
export async function createStack(options: StackOptions = {}) {
  const issuer = await TokenIssuer.create(ISSUER);
  const keys = createLocalJWKSet(await issuer.jwks());
  const idp = new Hono().route(
    '/',
    tokenExchangeRoutes({
      issuer,
      clients: { bot: BOT_SECRET, 'mcp-gateway': GATEWAY_SECRET },
      revocations: new MemoryRevocationStore(),
      logger: pino({ level: 'silent' }),
    }),
  );
  const accountsRepo = new InMemoryAccountsRepository();
  const transfersRepo = new InMemoryTransfersRepository();
  const accounts = createAccountsApp({
    verify: createJwtVerifier({
      issuer: ISSUER,
      audience: 'mcp-accounts',
      allowedActorChains: ACCOUNTS_CHAINS,
      keys,
    }),
    accounts: accountsRepo,
  });
  const payments = createPaymentsApp({
    verify: createJwtVerifier({
      issuer: ISSUER,
      audience: 'mcp-payments',
      allowedActorChains: PAYMENTS_CHAINS,
      keys,
    }),
    transfers: transfersRepo,
    verifyStepUp: createStepUpVerifier({ issuer: ISSUER, audience: 'mcp-payments', keys }),
  });

  const apps: Record<string, Hono> = { 'idp.test': idp, 'accounts.test': accounts, 'payments.test': payments };
  const seen: SeenRequest[] = [];
  const routedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const host = new URL(request.url).host;
    seen.push({
      host,
      authorization: request.headers.get('authorization'),
      traceparent: request.headers.get('traceparent'),
      body: await request.clone().text(),
    });
    if (options.down?.has(host)) throw new TypeError('fetch failed');
    const forward = async () => (apps[host] as Hono).fetch(request.clone());
    return (await options.intercept?.(host, request, forward)) ?? forward();
  };

  const exchanger = createTokenExchanger({
    tokenUrl: 'http://idp.test/token',
    clientId: 'mcp-gateway',
    clientSecret: GATEWAY_SECRET,
    fetch: routedFetch,
  });
  const proxy = createProxy({
    backends: options.backends ?? BACKENDS,
    exchanger,
    logger: options.logger ?? pino({ level: 'silent' }),
    client: createBackendClient({ fetch: routedFetch, timeoutMs: 2000 }),
    ...options.proxy,
  });
  const gateway = createApp({
    verify: createJwtVerifier({ issuer: ISSUER, audience: AUDIENCE, allowedActors: ALLOWED_ACTORS, keys }),
    proxy,
  });

  /**
   * What the bot does: exchange a customer's `aud=bot` token at the IdP for one for the gateway. The default is
   * what a run that loaded accounts and payments holds; the IdP refuses the bot a request with no scope.
   */
  async function gatewayToken(sub: string, scope = PRE_APPROVAL_SCOPES): Promise<string> {
    return exchangeAs('bot', BOT_SECRET, await issuer.issueBotToken({ sub, sid: SESSION_ID }), AUDIENCE, scope);
  }

  async function exchangeAs(client: string, secret: string, subject: string, audience: string, scope?: string) {
    const res = await idp.request('/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${client}:${secret}`).toString('base64')}`,
      },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
        subject_token: subject,
        subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
        audience,
        ...(scope && { scope }),
      }),
    });
    const body = (await res.json()) as { access_token?: string };
    if (!body.access_token) throw new Error(`exchange failed: ${JSON.stringify(body)}`);
    return body.access_token;
  }

  async function connect(token: string, headers: Record<string, string> = {}): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL('http://gateway.test/mcp'), {
      fetch: async (url, init) => gateway.request(url.toString(), init),
      requestInit: { headers: { authorization: `Bearer ${token}`, ...headers } },
    });
    const client = new Client({ name: 'bot', version: '0.0.0' });
    await client.connect(transport);
    return client;
  }

  /** Talks to a backend directly, past the gateway, as a caller holding `token`. */
  async function connectBackend(host: 'accounts.test' | 'payments.test', token: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`http://${host}/mcp`), {
      fetch: async (url, init) => (apps[host] as Hono).request(url.toString(), init),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: 'direct', version: '0.0.0' });
    await client.connect(transport);
    return client;
  }

  return {
    connectBackend,
    issuer,
    gateway,
    proxy,
    accountsRepo,
    transfersRepo,
    seen,
    gatewayToken,
    exchangeAs,
    connect,
    audienceOf: (token: string) => decodeJwt(token).aud,
  };
}

export type Stack = Awaited<ReturnType<typeof createStack>>;

export function parseText(result: object): Record<string, unknown> {
  const first = ((result as { content?: unknown }).content as { type: string; text?: string }[])[0];
  return JSON.parse(first?.text ?? '{}') as Record<string, unknown>;
}
