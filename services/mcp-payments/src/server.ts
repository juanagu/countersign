import { serve } from '@hono/node-server';
import { createJwtVerifier, remoteJwks } from '@poc/mcp-kit';
import pg from 'pg';
import { pino } from 'pino';
import { AUDIENCE, createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';
import { PgTransfersRepository } from './features/transfers/pg-transfers-repository.js';

const config = loadConfig();
const logger = pino({ name: SERVICE_NAME, level: config.logLevel });
const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
const verify = createJwtVerifier({
  issuer: config.idpIssuer,
  audience: AUDIENCE,
  allowedActors: ['bot'],
  keys: remoteJwks(config.idpJwksUrl),
});

serve(
  { fetch: createApp({ verify, transfers: new PgTransfersRepository(pool), logger }).fetch, port: config.port },
  (info) => logger.info({ port: info.port }, 'listening'),
);
