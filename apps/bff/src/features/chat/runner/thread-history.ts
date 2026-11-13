import type { Message } from '@ag-ui/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { TokenIssuer } from '../../idp/token-issuer.js';

/** A thread's stored conversation, for a restore after the replay window. Scoped to the owner by the bot. */
export interface ThreadHistory {
  messagesFor(threadId: string, owner: string): Promise<Message[]>;
}

const ROLES = ['user', 'assistant', 'tool', 'system', 'developer', 'activity', 'reasoning'] as const;
const historySchema = z.object({
  messages: z.array(z.looseObject({ id: z.string().min(1), role: z.enum(ROLES) })),
});

/** Reads the bot's Postgres-backed history with an `aud=bot` token minted for the thread's owner. */
export class BotThreadHistory implements ThreadHistory {
  constructor(
    private readonly issuer: TokenIssuer,
    private readonly botAgentUrl: string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async messagesFor(threadId: string, owner: string): Promise<Message[]> {
    const url = new URL(`/threads/${encodeURIComponent(threadId)}/messages`, this.botAgentUrl);
    try {
      const token = await this.issuer.issueBotToken({ sub: owner, name: '' });
      const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`history request failed: ${res.status}`);
      return historySchema.parse(await res.json()).messages as Message[];
    } catch (error) {
      // A restore that fails shows an empty thread; it must not break the connect.
      this.logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'thread history unavailable');
      return [];
    }
  }
}
