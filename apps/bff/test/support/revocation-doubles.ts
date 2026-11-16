import { Writable } from 'node:stream';
import { pino } from 'pino';
import type { RevocationStore } from '../../src/features/idp/revocation-store.js';
import { MemoryRevocationStore } from './memory-revocation-store.js';

/** A memory store that remembers what was revoked and for how long. */
export class RecordingRevocationStore extends MemoryRevocationStore {
  readonly calls: { sid: string; ttlSeconds: number }[] = [];

  override async revoke(sid: string, ttlSeconds: number): Promise<void> {
    this.calls.push({ sid, ttlSeconds });
    return super.revoke(sid, ttlSeconds);
  }
}

/** A memory store that can be taken down and brought back, to retry what failed during the outage. */
export class SwitchableRevocationStore extends MemoryRevocationStore {
  down = false;

  override async revoke(sid: string, ttlSeconds: number): Promise<void> {
    if (this.down) throw new Error('redis down');
    return super.revoke(sid, ttlSeconds);
  }

  override async isRevoked(sid: string): Promise<boolean> {
    if (this.down) throw new Error('redis down');
    return super.isRevoked(sid);
  }
}

/** Counts lookups, and answers "revoked" to every one after the first `freshFor`: a logout landing mid-request. */
export class CountingRevocationStore extends MemoryRevocationStore {
  lookups = 0;

  constructor(private readonly freshFor = Infinity) {
    super();
  }

  override async isRevoked(sid: string): Promise<boolean> {
    this.lookups += 1;
    return this.lookups > this.freshFor || super.isRevoked(sid);
  }
}

/** A store whose backing service is down: every call rejects. */
export class UnavailableRevocationStore implements RevocationStore {
  async revoke(): Promise<void> {
    throw new Error('redis down');
  }

  async isRevoked(): Promise<boolean> {
    throw new Error('redis down');
  }
}

/** A real pino logger whose lines are collected, to assert on what a service logs. */
export function capturingLogger() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { logger: pino({ level: 'info' }, stream), lines };
}
