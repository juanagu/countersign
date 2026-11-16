import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { RedisRevocationStore, revocationKey } from '../../../src/features/idp/redis-revocation-store.js';
import type { RevocationStore } from '../../../src/features/idp/revocation-store.js';
import { createRedisClient } from '../../../src/features/chat/runner/redis-thread-log.js';
import { MemoryRevocationStore } from '../../support/memory-revocation-store.js';
import { connectTestRedis } from '../../support/redis.js';

const redis = await connectTestRedis();
afterAll(() => redis?.destroy());

const created: string[] = [];
afterEach(async () => {
  if (redis && created.length > 0) await redis.del(created.splice(0));
});

const newSid = () => {
  const sid = `test-${randomUUID()}`;
  created.push(revocationKey(sid));
  return sid;
};

// The in-memory store stands in for Redis in the route tests, so both keep the same contract.
const stores: [string, boolean, () => RevocationStore][] = [
  ['memory', true, () => new MemoryRevocationStore()],
  [
    'redis',
    redis !== null,
    () => new RedisRevocationStore(redis as NonNullable<typeof redis>, { commandTimeoutMs: 1000 }),
  ],
];

describe.each(stores)('%s revocation store', (_, available, make) => {
  const run = it.runIf(available);

  run('knows only the sids that were revoked', async () => {
    const store = make();
    const [dead, live] = [newSid(), newSid()];
    await store.revoke(dead, 60);
    expect(await store.isRevoked(dead)).toBe(true);
    expect(await store.isRevoked(live)).toBe(false);
  });

  run('forgets a sid once its time is up', async () => {
    const store = make();
    const sid = newSid();
    await store.revoke(sid, 1);
    expect(await store.isRevoked(sid)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await store.isRevoked(sid)).toBe(false);
  });
});

describe('redis revocation store', () => {
  it.runIf(redis !== null)('keeps the key under auth:revoked:{sid} with the TTL it was given', async () => {
    const sid = newSid();
    await new RedisRevocationStore(redis as NonNullable<typeof redis>, { commandTimeoutMs: 1000 }).revoke(sid, 120);
    expect(revocationKey(sid)).toBe(`auth:revoked:${sid}`);
    const ttl = await (redis as NonNullable<typeof redis>).ttl(revocationKey(sid));
    expect(ttl).toBeGreaterThan(110);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('rejects instead of hanging when the client never answers (Redis down, commands queued)', async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    const store = new RedisRevocationStore({ set: () => never, exists: () => never }, { commandTimeoutMs: 50 });
    const outcome = expect(store.isRevoked('sid')).rejects.toThrow('timeout');
    await vi.advanceTimersByTimeAsync(60);
    await outcome;
    vi.useRealTimers();
  });

  it('fails at once while disconnected, instead of queueing the command until the deadline', async () => {
    const offline = createRedisClient('redis://127.0.0.1:1', { disableOfflineQueue: true });
    offline.on('error', () => undefined);
    void offline.connect().catch(() => undefined); // Connecting, never connected: what an outage looks like.
    const store = new RedisRevocationStore(offline, { commandTimeoutMs: 1000 });
    const started = Date.now();

    const failure = await store.isRevoked('sid').catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).not.toContain('timeout');
    expect(Date.now() - started).toBeLessThan(300);
    offline.destroy();
  });

  it('passes a client error through so callers can fail closed', async () => {
    const broken = new RedisRevocationStore(
      {
        set: async () => Promise.reject(new Error('ECONNREFUSED')),
        exists: async () => Promise.reject(new Error('ECONNREFUSED')),
      },
      { commandTimeoutMs: 50 },
    );
    await expect(broken.isRevoked('sid')).rejects.toThrow('ECONNREFUSED');
    await expect(broken.revoke('sid', 10)).rejects.toThrow('ECONNREFUSED');
  });
});
