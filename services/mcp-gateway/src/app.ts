import { mcpRoute, type VerifyAccessToken } from '@poc/mcp-kit';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import type { Proxy } from './features/proxy/proxy.js';

export const SERVICE_NAME = 'mcp-gateway';
/** The `aud` this gateway accepts. The bot's token for any other audience, or a backend's, is rejected. */
export const AUDIENCE = 'mcp-gateway';
/** The only party that may present a token here: the bot, acting for a customer. */
export const ALLOWED_ACTORS = ['bot'] as const;

export interface AppDeps {
  verify: VerifyAccessToken;
  proxy: Proxy;
  logger?: Logger;
}

export function createApp({ verify, proxy, logger }: AppDeps): Hono {
  const app = new Hono();
  app.get('/health', (c) => {
    const health = proxy.health();
    return c.json({ ...health, service: SERVICE_NAME }, health.status === 'unhealthy' ? 503 : 200);
  });
  app.route(
    '/',
    mcpRoute({
      verify,
      buildServer: proxy.buildServer,
      onRejected: (reason) => logger?.warn({ reason }, 'rejected access token'),
    }),
  );
  return app;
}
