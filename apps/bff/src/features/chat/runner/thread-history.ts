import type { Message } from '@ag-ui/client';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { TokenIssuer } from '../../idp/token-issuer.js';

/** A thread's stored conversation, for a restore after the replay window. Scoped to the owner by the bot. */
export interface ThreadHistory {
  /** `headers` are the connect request's: the runtime puts the caller's per-request `aud=bot` token in them. */
  messagesFor(threadId: string, owner: string, headers: Readonly<Record<string, string>>): Promise<Message[]>;
}

const BEARER = /^Bearer (.+)$/;

function bearerOf(headers: Readonly<Record<string, string>>): string | undefined {
  const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization');
  return entry && BEARER.exec(entry[1])?.[1];
}

const ROLES = ['user', 'assistant', 'tool', 'system', 'developer', 'activity', 'reasoning'] as const;
const historySchema = z.object({
  messages: z.array(z.looseObject({ id: z.string().min(1), role: z.enum(ROLES) })),
});

/**
 * Reads the bot's Postgres-backed history with an `aud=bot` token minted for the thread's owner, in the session
 * the caller's own bot token descends from (so it carries that `sid`). A caller token that does not verify, or
 * belongs to another user, gets no history.
 */
export class BotThreadHistory implements ThreadHistory {
  constructor(
    private readonly issuer: TokenIssuer,
    private readonly botAgentUrl: string,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async callerSession(headers: Readonly<Record<string, string>>, owner: string) {
    const bearer = bearerOf(headers);
    if (!bearer) throw new Error('no caller token');
    const caller = await this.issuer.verifyBotToken(bearer);
    if (caller.sub !== owner) throw new Error('caller token belongs to another user');
    return caller;
  }

  async messagesFor(threadId: string, owner: string, headers: Readonly<Record<string, string>>): Promise<Message[]> {
    const url = new URL(`/threads/${encodeURIComponent(threadId)}/messages`, this.botAgentUrl);
    try {
      const token = await this.issuer.issueBotToken(await this.callerSession(headers, owner));
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
