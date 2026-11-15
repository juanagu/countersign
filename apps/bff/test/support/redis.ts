import {
  createRedisClient,
  RedisThreadLog,
  type RedisClient,
} from '../../src/features/chat/runner/redis-thread-log.js';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
// CI sets TEST_REDIS_URL and runs a Redis service, so there an unreachable Redis fails instead of skipping.
const REDIS_REQUIRED = process.env.TEST_REDIS_URL !== undefined;
const CONNECT_TIMEOUT_MS = REDIS_REQUIRED ? 5_000 : 500;
export const TEST_LOG_OPTIONS = { replayWindowMs: 60_000, ownerTtlMs: 60_000, runLeaseMs: 2_000 };

/** A connected client for the compose Redis, or null when it is not up and not required (those tests then skip). */
export async function connectTestRedis(): Promise<RedisClient | null> {
  const client = createRedisClient(TEST_REDIS_URL);
  client.on('error', () => undefined);
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), CONNECT_TIMEOUT_MS)),
    ]);
    return client;
  } catch (error) {
    client.destroy();
    if (REDIS_REQUIRED)
      throw new Error(`TEST_REDIS_URL is set but Redis is unreachable at ${TEST_REDIS_URL}`, { cause: error });
    return null;
  }
}

export function redisLogOrThrow(client: RedisClient | null): RedisThreadLog {
  if (!client) throw new Error('Redis is not up');
  return new RedisThreadLog(client, TEST_LOG_OPTIONS);
}
