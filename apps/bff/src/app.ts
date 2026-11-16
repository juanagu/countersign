import { Hono } from 'hono';
import type { Logger } from 'pino';
import { requireJsonPost } from './core/require-json.js';
import { chatRoutes, COPILOT_BASE_PATH } from './features/chat/copilot-endpoint.js';
import type { ThreadLog } from './features/chat/runner/thread-log.js';
import { idpRoutes } from './features/idp/routes.js';
import type { RevocationStore } from './features/idp/revocation-store.js';
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
  /** Logged-out session ids (Redis in the stack). */
  revocations: RevocationStore;
  threadLog: ThreadLog;
  logger: Logger;
}

export function createApp(deps: AppDeps): Hono {
  const { issuer, botAgentUrl, cookieSecure, clients, stepUpPin, revocations, threadLog, logger } = deps;
  const session = { issuer, revocations, cookieSecure, logger };
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', service: SERVICE_NAME }));
  app.use('/auth/*', requireJsonPost);
  app.use(`${COPILOT_BASE_PATH}/*`, requireJsonPost);
  app.route('/', idpRoutes(session));
  app.route('/', tokenExchangeRoutes({ issuer, clients, revocations, logger }));
  app.route('/', stepUpRoutes({ ...session, pin: stepUpPin }));
  app.route('/', chatRoutes({ ...session, botAgentUrl, threadLog }));
  return app;
}
