import type { BaseEvent } from '@ag-ui/client';
import { createClient } from 'redis';
import type { LoggedEvent, ThreadLog } from './thread-log.js';

/**
 * `disableOfflineQueue` makes a command issued while Redis is down fail at once instead of waiting, so an outage
 * can neither pile stale commands up nor replay them on reconnect (the revocation store's client sets it).
 */
export function createRedisClient(url: string, options: { disableOfflineQueue?: boolean } = {}) {
  return createClient({ url, ...options });
}

export type RedisClient = ReturnType<typeof createRedisClient>;

export interface RedisThreadLogOptions {
  /** How long a thread's events stay replayable after its last event. */
  replayWindowMs: number;
  /** How long the owner is remembered after the thread's last run. */
  ownerTtlMs: number;
  /** A run lease that is not renewed within this time is free again. */
  runLeaseMs: number;
}

const EVENT_FIELD = 'e';

// INCR and XADD in one step, so `seq` and the stream id never disagree.
const APPEND_SCRIPT = `
local seq = redis.call('INCR', KEYS[2])
redis.call('XADD', KEYS[1], seq .. '-0', '${EVENT_FIELD}', ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[2])
redis.call('PEXPIRE', KEYS[2], ARGV[2])
return seq`;
const RENEW_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;
const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

const keys = (threadId: string) => {
  const base = `chat:thread:{${threadId}}`;
  return { events: `${base}:events`, seq: `${base}:seq`, owner: `${base}:owner`, run: `${base}:run` };
};

interface StreamEntry {
  id: string;
  message: Record<string, string>;
}

function toLogged(entries: readonly StreamEntry[]): LoggedEvent[] {
  return entries.map(({ id, message }) => ({
    seq: Number(id.split('-')[0]),
    event: JSON.parse(message[EVENT_FIELD] ?? '{}') as BaseEvent,
  }));
}

export class RedisThreadLog implements ThreadLog {
  constructor(
    private readonly client: RedisClient,
    private readonly options: RedisThreadLogOptions,
  ) {}

  async claim(threadId: string, owner: string): Promise<boolean> {
    const key = keys(threadId).owner;
    const px = { type: 'PX', value: this.options.ownerTtlMs } as const;
    if ((await this.client.set(key, owner, { condition: 'NX', expiration: px })) === 'OK') return true;
    if ((await this.client.get(key)) !== owner) return false;
    await this.client.pExpire(key, this.options.ownerTtlMs);
    return true;
  }

  ownerOf(threadId: string): Promise<string | null> {
    return this.client.get(keys(threadId).owner);
  }

  async acquireRun(threadId: string, runId: string): Promise<boolean> {
    const expiration = { type: 'PX', value: this.options.runLeaseMs } as const;
    return (await this.client.set(keys(threadId).run, runId, { condition: 'NX', expiration })) === 'OK';
  }

  async renewRun(threadId: string, runId: string): Promise<void> {
    const args = [runId, String(this.options.runLeaseMs)];
    await this.client.eval(RENEW_SCRIPT, { keys: [keys(threadId).run], arguments: args });
  }

  async releaseRun(threadId: string, runId: string): Promise<void> {
    await this.client.eval(RELEASE_SCRIPT, { keys: [keys(threadId).run], arguments: [runId] });
  }

  activeRun(threadId: string): Promise<string | null> {
    return this.client.get(keys(threadId).run);
  }

  async append(threadId: string, event: BaseEvent): Promise<number> {
    const { events, seq } = keys(threadId);
    const args = [JSON.stringify(event), String(this.options.replayWindowMs)];
    return Number(await this.client.eval(APPEND_SCRIPT, { keys: [events, seq], arguments: args }));
  }

  async readAfter(threadId: string, afterSeq: number): Promise<LoggedEvent[]> {
    const entries = await this.client.xRange(keys(threadId).events, `(${afterSeq}-0`, '+');
    return toLogged(entries as StreamEntry[]);
  }

  async *follow(threadId: string, afterSeq: number, waitMs: number, signal: AbortSignal) {
    // XREAD BLOCK holds its connection, so each follower gets its own and closes it when done.
    const reader = this.client.duplicate();
    const close = () => reader.destroy();
    signal.addEventListener('abort', close, { once: true });
    let cursor = afterSeq;
    try {
      await reader.connect();
      while (!signal.aborted) {
        const reply = await reader.xRead({ key: keys(threadId).events, id: `${cursor}-0` }, { BLOCK: waitMs });
        const batch = toLogged(((reply as { messages: StreamEntry[] }[] | null)?.[0]?.messages ?? []) as StreamEntry[]);
        cursor = batch.at(-1)?.seq ?? cursor;
        yield batch;
      }
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      signal.removeEventListener('abort', close);
      if (reader.isOpen) reader.destroy();
    }
  }
}
