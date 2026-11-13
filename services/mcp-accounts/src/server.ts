import { serve } from '@hono/node-server';
import { createJwtVerifier, remoteJwks } from '@poc/mcp-kit';
import pg from 'pg';
import { pino } from 'pino';
import { AUDIENCE, createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';
import { PgAccountsRepository } from './features/accounts/pg-accounts-repository.js';

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
  { fetch: createApp({ verify, accounts: new PgAccountsRepository(pool), logger }).fetch, port: config.port },
  (info) => logger.info({ port: info.port }, 'listening'),
);
