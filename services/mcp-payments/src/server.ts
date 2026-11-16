import { serve } from '@hono/node-server';
import { createJwtVerifier, remoteJwks } from '@poc/mcp-kit';
import pg from 'pg';
import { pino } from 'pino';
import { ALLOWED_ACTOR_CHAINS, AUDIENCE, createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';
import { PgTransfersRepository } from './features/transfers/pg-transfers-repository.js';
import { createStepUpVerifier } from './features/transfers/step-up-verifier.js';

const config = loadConfig();
const logger = pino({ name: SERVICE_NAME, level: config.logLevel });
// A call waits at most this long for a connection, inside the call's deadline.
const CONNECTION_TIMEOUT_MS = 2000;
const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 5,
  connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
});
const keys = remoteJwks(config.idpJwksUrl);
const verify = createJwtVerifier({
  issuer: config.idpIssuer,
  audience: AUDIENCE,
  allowedActorChains: ALLOWED_ACTOR_CHAINS,
  keys,
});
const verifyStepUp = createStepUpVerifier({ issuer: config.idpIssuer, audience: AUDIENCE, keys });

serve(
  {
    fetch: createApp({ verify, verifyStepUp, transfers: new PgTransfersRepository(pool), logger }).fetch,
    port: config.port,
  },
  (info) => logger.info({ port: info.port }, 'listening'),
);
