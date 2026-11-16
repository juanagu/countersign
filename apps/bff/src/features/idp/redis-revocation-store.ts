import type { RevocationStore } from './revocation-store.js';

/** The two commands the store uses, so it never holds a client that can do anything else. */
export interface RevocationRedis {
  set(key: string, value: string, options: { expiration: { type: 'EX'; value: number } }): Promise<unknown>;
  exists(key: string): Promise<number>;
}

export interface RedisRevocationStoreOptions {
  /** A command that takes longer fails, so a connected but unresponsive Redis cannot hang a request. */
  commandTimeoutMs: number;
}

export const revocationKey = (sid: string): string => `auth:revoked:${sid}`;

export class RedisRevocationStore implements RevocationStore {
  constructor(
    private readonly client: RevocationRedis,
    private readonly options: RedisRevocationStoreOptions,
  ) {}

  async revoke(sid: string, ttlSeconds: number): Promise<void> {
    await this.withDeadline(
      this.client.set(revocationKey(sid), '1', { expiration: { type: 'EX', value: Math.ceil(ttlSeconds) } }),
    );
  }

  async isRevoked(sid: string): Promise<boolean> {
    return (await this.withDeadline(this.client.exists(revocationKey(sid)))) > 0;
  }

  private async withDeadline<T>(command: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('revocation store timeout')), this.options.commandTimeoutMs);
    });
    try {
      return await Promise.race([command, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }
}
