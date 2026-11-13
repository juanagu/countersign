import { randomUUID } from 'node:crypto';
import type { BaseEvent } from '@ag-ui/client';
import { afterAll, describe, expect, it } from 'vitest';
import type { ThreadLog } from '../../../../src/features/chat/runner/thread-log.js';
import { MemoryThreadLog } from '../../../support/memory-thread-log.js';
import { connectTestRedis, redisLogOrThrow } from '../../../support/redis.js';

const redis = await connectTestRedis();
afterAll(() => redis?.destroy());

const event = (n: number) => ({ type: 'CUSTOM', name: 'n', value: n }) as BaseEvent;

// The in-memory log stands in for Redis in the endpoint tests, so both must keep the same contract.
const logs: [string, boolean, () => ThreadLog][] = [
  ['memory', true, () => new MemoryThreadLog()],
  ['redis', redis !== null, () => redisLogOrThrow(redis)],
];

describe.each(logs)('%s thread log', (_, available, make) => {
  const run = it.runIf(available);

  run('numbers events 1, 2, 3… per thread and reads them after a seq', async () => {
    const log = make();
    const threadId = randomUUID();
    expect([await log.append(threadId, event(1)), await log.append(threadId, event(2))]).toEqual([1, 2]);
    await log.append(threadId, event(3));
    expect((await log.readAfter(threadId, 1)).map((e) => e.seq)).toEqual([2, 3]);
    expect((await log.readAfter(threadId, 0)).map((e) => (e.event as unknown as { value: number }).value)).toEqual([
      1, 2, 3,
    ]);
    expect(await log.readAfter(randomUUID(), 0)).toEqual([]);
  });

  run('keeps the first owner; another owner cannot claim the thread', async () => {
    const log = make();
    const threadId = randomUUID();
    expect(await log.claim(threadId, 'ana')).toBe(true);
    expect(await log.claim(threadId, 'juan')).toBe(false);
    expect(await log.claim(threadId, 'ana')).toBe(true);
    expect(await log.ownerOf(threadId)).toBe('ana');
  });

  run('holds one run lease per thread, released only by its run', async () => {
    const log = make();
    const threadId = randomUUID();
    expect(await log.acquireRun(threadId, 'r1')).toBe(true);
    expect(await log.acquireRun(threadId, 'r2')).toBe(false);
    await log.releaseRun(threadId, 'r2');
    expect(await log.activeRun(threadId)).toBe('r1');
    await log.releaseRun(threadId, 'r1');
    expect(await log.activeRun(threadId)).toBeNull();
  });

  run('follows new events from a seq without repeating or skipping any', async () => {
    const log = make();
    const threadId = randomUUID();
    await log.append(threadId, event(1));
    const abort = new AbortController();
    const seen: number[] = [];
    const following = (async () => {
      for await (const batch of log.follow(threadId, 1, 200, abort.signal)) {
        seen.push(...batch.map((e) => e.seq));
        if (seen.length >= 3) abort.abort();
      }
    })();
    for (const n of [2, 3, 4]) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await log.append(threadId, event(n));
    }
    await following;
    expect(seen).toEqual([2, 3, 4]);
  });
});
