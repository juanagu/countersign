import { Writable } from 'node:stream';
import { pino } from 'pino';
import { MemoryRevocationStore, type RevocationStore } from '../../src/features/idp/revocation-store.js';

/** A memory store that remembers what was revoked and for how long. */
export class RecordingRevocationStore extends MemoryRevocationStore {
  readonly calls: { sid: string; ttlSeconds: number }[] = [];

  override async revoke(sid: string, ttlSeconds: number): Promise<void> {
    this.calls.push({ sid, ttlSeconds });
    return super.revoke(sid, ttlSeconds);
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
