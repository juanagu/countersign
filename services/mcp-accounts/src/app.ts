import { mcpRoute, type VerifyAccessToken } from '@poc/mcp-kit';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import { buildAccountsServer } from './features/accounts/account-tools.js';
import type { AccountsRepository } from './features/accounts/accounts-repository.js';

export const SERVICE_NAME = 'mcp-accounts';
/** The `aud` this server accepts: tokens exchanged for any other audience are rejected. */
export const AUDIENCE = 'mcp-accounts';
/** The only delegation chain accepted, outermost first: the gateway, acting for the bot, acting for a customer (ADR 017). */
export const ALLOWED_ACTOR_CHAINS = [['mcp-gateway', 'bot']] as const;

export interface AppDeps {
  verify: VerifyAccessToken;
  accounts: AccountsRepository;
  logger?: Logger;
}

export function createApp({ verify, accounts, logger }: AppDeps): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', service: SERVICE_NAME }));
  app.route(
    '/',
    mcpRoute({
      verify,
      buildServer: (principal) => buildAccountsServer(principal, accounts),
      onRejected: (reason) => logger?.warn({ reason }, 'rejected access token'),
    }),
  );
  return app;
}
