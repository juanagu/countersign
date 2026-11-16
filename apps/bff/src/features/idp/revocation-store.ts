/** Session ids that were logged out. A token whose `sid` is here is dead everywhere the IdP checks. */
export interface RevocationStore {
  /** Marks `sid` revoked for `ttlSeconds`, after which the session could not be valid anyway. */
  revoke(sid: string, ttlSeconds: number): Promise<void>;
  /** Rejects when the store cannot answer: callers fail closed. */
  isRevoked(sid: string): Promise<boolean>;
}
