import { Hono } from 'hono';
import { chatRoutes } from './features/chat/copilot-endpoint.js';
import { idpRoutes } from './features/idp/routes.js';
import type { TokenIssuer } from './features/idp/token-issuer.js';

export const SERVICE_NAME = 'bff';

export interface AppDeps {
  issuer: TokenIssuer;
  botAgentUrl: string;
  cookieSecure: boolean;
}

export function createApp({ issuer, botAgentUrl, cookieSecure }: AppDeps): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', service: SERVICE_NAME }));
  app.route('/', idpRoutes({ issuer, cookieSecure }));
  app.route('/', chatRoutes({ issuer, botAgentUrl }));
  return app;
}
