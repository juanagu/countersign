import { serve } from '@hono/node-server';
import { createJwtVerifier, remoteJwks } from '@poc/mcp-kit';
import { pino } from 'pino';
import { ALLOWED_ACTORS, AUDIENCE, createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';
import { defaultBackends } from './features/proxy/backends.js';
import { createProxy } from './features/proxy/proxy.js';
import { createTokenExchanger } from './features/proxy/token-exchanger.js';

const config = loadConfig();
const logger = pino({ name: SERVICE_NAME, level: config.logLevel });
const verify = createJwtVerifier({
  issuer: config.idpIssuer,
  audience: AUDIENCE,
  allowedActors: ALLOWED_ACTORS,
  keys: remoteJwks(config.idpJwksUrl),
});
const exchanger = createTokenExchanger({
  tokenUrl: config.idpTokenUrl,
  clientId: SERVICE_NAME,
  clientSecret: config.clientSecret,
});
const proxy = createProxy({ backends: defaultBackends(config), exchanger, logger });

serve({ fetch: createApp({ verify, proxy, logger }).fetch, port: config.port }, (info) =>
  logger.info({ port: info.port }, 'listening'),
);
