/** Session ids that were logged out. A token whose `sid` is here is dead everywhere the IdP checks (ADR 024). */
export interface RevocationStore {
  /** Marks `sid` revoked for `ttlSeconds`, after which the session could not be valid anyway. */
  revoke(sid: string, ttlSeconds: number): Promise<void>;
  /** Rejects when the store cannot answer: callers fail closed. */
  isRevoked(sid: string): Promise<boolean>;
}

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
