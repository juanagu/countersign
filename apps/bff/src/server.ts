import { serve } from '@hono/node-server';
import { createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { TokenIssuer } from './features/idp/token-issuer.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const issuer = await TokenIssuer.create(config.idpIssuer);
const app = createApp({
  issuer,
  botAgentUrl: config.botAgentUrl,
  cookieSecure: config.cookieSecure,
  clients: { bot: config.botClientSecret },
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ service: SERVICE_NAME, port: info.port }, 'listening');
});
