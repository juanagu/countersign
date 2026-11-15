import { Hono } from 'hono';
import type { Logger } from 'pino';
import { requireJsonPost } from './core/require-json.js';
import { chatRoutes, COPILOT_BASE_PATH } from './features/chat/copilot-endpoint.js';
import type { ThreadLog } from './features/chat/runner/thread-log.js';
import { idpRoutes } from './features/idp/routes.js';
import { stepUpRoutes } from './features/idp/step-up.js';
import { tokenExchangeRoutes } from './features/idp/token-exchange.js';
import type { TokenIssuer } from './features/idp/token-issuer.js';

export const SERVICE_NAME = 'bff';

export interface AppDeps {
  issuer: TokenIssuer;
  botAgentUrl: string;
  cookieSecure: boolean;
  /** Confidential clients of the token endpoint: client_id → secret. */
  clients: Readonly<Record<string, string>>;
  stepUpPin: string;
  threadLog: ThreadLog;
  logger: Logger;
}

export function createApp(deps: AppDeps): Hono {
  const { issuer, botAgentUrl, cookieSecure, clients, stepUpPin, threadLog, logger } = deps;
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', service: SERVICE_NAME }));
  app.use('/auth/*', requireJsonPost);
  app.use(`${COPILOT_BASE_PATH}/*`, requireJsonPost);
  app.route('/', idpRoutes({ issuer, cookieSecure }));
  app.route('/', tokenExchangeRoutes({ issuer, clients, logger }));
  app.route('/', stepUpRoutes({ issuer, pin: stepUpPin }));
  app.route('/', chatRoutes({ issuer, botAgentUrl, threadLog, logger }));
  return app;
}
