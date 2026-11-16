import type { RevocationStore } from '../../src/features/idp/revocation-store.js';

/** The in-memory stand-in for the Redis store in tests; it honours the same expiry contract. */
export class MemoryRevocationStore implements RevocationStore {
  private readonly revoked = new Map<string, number>();

  async revoke(sid: string, ttlSeconds: number): Promise<void> {
    this.revoked.set(sid, Date.now() + ttlSeconds * 1000);
  }

  async isRevoked(sid: string): Promise<boolean> {
    const until = this.revoked.get(sid);
    if (until === undefined) return false;
    if (Date.now() < until) return true;
    this.revoked.delete(sid);
    return false;
  }
}
