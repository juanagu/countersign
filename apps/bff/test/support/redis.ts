import {
  createRedisClient,
  RedisThreadLog,
  type RedisClient,
} from '../../src/features/chat/runner/redis-thread-log.js';

export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
export const TEST_LOG_OPTIONS = { replayWindowMs: 60_000, ownerTtlMs: 60_000, runLeaseMs: 2_000 };

/** A connected client for the compose Redis, or null when it is not up (those tests then skip). */
export async function connectTestRedis(): Promise<RedisClient | null> {
  const client = createRedisClient(TEST_REDIS_URL);
  client.on('error', () => undefined);
  try {
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500)),
    ]);
    return client;
  } catch {
    client.destroy();
    return null;
  }
}

export function redisLogOrThrow(client: RedisClient | null): RedisThreadLog {
  if (!client) throw new Error('Redis is not up');
  return new RedisThreadLog(client, TEST_LOG_OPTIONS);
}
