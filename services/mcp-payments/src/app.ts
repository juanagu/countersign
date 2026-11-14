import { mcpRoute, type VerifyAccessToken } from '@poc/mcp-kit';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import { buildPaymentsServer } from './features/transfers/transfer-tools.js';
import type { VerifyStepUp } from './features/transfers/step-up-verifier.js';
import type { TransfersRepository } from './features/transfers/transfers-repository.js';

export const SERVICE_NAME = 'mcp-payments';
/** The `aud` this server accepts: tokens exchanged for any other audience are rejected. */
export const AUDIENCE = 'mcp-payments';
/** The only delegation chain accepted, outermost first: the gateway, acting for the bot, acting for a customer (ADR 017). */
export const ALLOWED_ACTOR_CHAINS = [['mcp-gateway', 'bot']] as const;

export interface AppDeps {
  verify: VerifyAccessToken;
  transfers: TransfersRepository;
  verifyStepUp: VerifyStepUp;
  now?: () => Date;
  logger?: Logger;
}

export function createApp({ verify, transfers, verifyStepUp, now, logger }: AppDeps): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', service: SERVICE_NAME }));
  app.route(
    '/',
    mcpRoute({
      verify,
      buildServer: (principal) =>
        buildPaymentsServer(principal, { repo: transfers, verifyStepUp, ...(now && { now }) }),
      onRejected: (reason) => logger?.warn({ reason }, 'rejected access token'),
    }),
  );
  return app;
}
