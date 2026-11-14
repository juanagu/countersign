import { serve } from '@hono/node-server';
import { createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './core/logger.js';
import { createRedisClient, RedisThreadLog } from './features/chat/runner/redis-thread-log.js';
import { BOT_CLIENT, GATEWAY_CLIENT } from './features/idp/client-policies.js';
import { TokenIssuer } from './features/idp/token-issuer.js';

const MINUTE_MS = 60_000;
/** Replay window, owner memory and run lease (docs/decisions/015-resumable-streams.md). */
const THREAD_LOG_OPTIONS = { replayWindowMs: 15 * MINUTE_MS, ownerTtlMs: 24 * 60 * MINUTE_MS, runLeaseMs: 15_000 };

const config = loadConfig();
const logger = createLogger(config.logLevel);
const issuer = await TokenIssuer.create(config.idpIssuer);
const redis = createRedisClient(config.redisUrl);
redis.on('error', (error: unknown) => logger.error({ err: String(error) }, 'redis error'));
await redis.connect();
const app = createApp({
  issuer,
  botAgentUrl: config.botAgentUrl,
  cookieSecure: config.cookieSecure,
  clients: {
    [BOT_CLIENT]: config.botClientSecret,
    ...(config.mcpGatewayClientSecret && { [GATEWAY_CLIENT]: config.mcpGatewayClientSecret }),
  },
  stepUpPin: config.stepUpPin,
  threadLog: new RedisThreadLog(redis, THREAD_LOG_OPTIONS),
  logger,
});

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ service: SERVICE_NAME, port: info.port }, 'listening');
});
