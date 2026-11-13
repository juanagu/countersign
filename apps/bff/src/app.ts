import { Hono } from 'hono';
import { requireJsonPost } from './core/require-json.js';
import { chatRoutes, COPILOT_BASE_PATH } from './features/chat/copilot-endpoint.js';
import { idpRoutes } from './features/idp/routes.js';
import { tokenExchangeRoutes } from './features/idp/token-exchange.js';
import type { TokenIssuer } from './features/idp/token-issuer.js';

export const SERVICE_NAME = 'bff';

export interface AppDeps {
  issuer: TokenIssuer;
  botAgentUrl: string;
  cookieSecure: boolean;
  /** Confidential clients of the token endpoint: client_id → secret. */
  clients: Readonly<Record<string, string>>;
}

export function createApp({ issuer, botAgentUrl, cookieSecure, clients }: AppDeps): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', service: SERVICE_NAME }));
  app.use('/auth/*', requireJsonPost);
  app.use(`${COPILOT_BASE_PATH}/*`, requireJsonPost);
  app.route('/', idpRoutes({ issuer, cookieSecure }));
  app.route('/', tokenExchangeRoutes({ issuer, clients }));
  app.route('/', chatRoutes({ issuer, botAgentUrl }));
  return app;
}
