import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeJwt } from 'jose';

export interface FakeBotOptions {
  /** Text deltas each run streams, one per `delayMs`. */
  deltas?: readonly string[];
  delayMs?: number;
  /** The stored conversation per `${sub}:${threadId}`, served at GET /threads/:id/messages. */
  history?: Record<string, unknown[]>;
}

export interface FakeBot {
  url: string;
  server: Server;
  runs: number;
  /** `sub` of every history request, in order. */
  historyCallers: string[];
}

export const DEFAULT_DELTAS = Array.from({ length: 20 }, (_, i) => `parte ${i + 1}. `);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamRun(
  res: import('node:http').ServerResponse,
  raw: string,
  deltas: readonly string[],
  delayMs: number,
) {
  const { threadId = 't', runId = 'r' } = JSON.parse(raw || '{}') as { threadId?: string; runId?: string };
  const messageId = `m-${runId}`;
  const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send({ type: 'RUN_STARTED', threadId, runId });
  await sleep(delayMs);
  send({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
  for (const delta of deltas) {
    await sleep(delayMs);
    send({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta });
  }
  send({ type: 'TEXT_MESSAGE_END', messageId });
  send({ type: 'RUN_FINISHED', threadId, runId });
  res.end();
}

/** A stand-in bot: streams a run slowly (so a test can cut it) and serves per-user stored history. */
export async function startFakeBot(options: FakeBotOptions = {}): Promise<FakeBot> {
  const { deltas = DEFAULT_DELTAS, delayMs = 15, history = {} } = options;
  const bot: FakeBot = { url: '', server: createServer(), runs: 0, historyCallers: [] };
  bot.server.on('request', (req, res) => {
    const match = /^\/threads\/([^/]+)\/messages$/.exec(req.url ?? '');
    if (req.method === 'GET' && match) {
      const sub = String(decodeJwt((req.headers.authorization ?? '').replace(/^Bearer /, '')).sub);
      bot.historyCallers.push(sub);
      const messages = history[`${sub}:${decodeURIComponent(match[1] ?? '')}`] ?? [];
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ messages }));
      return;
    }
    bot.runs += 1;
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => void streamRun(res, raw, deltas, delayMs));
  });
  await new Promise<void>((resolve) => bot.server.listen(0, '127.0.0.1', resolve));
  bot.url = `http://127.0.0.1:${(bot.server.address() as AddressInfo).port}/agent`;
  return bot;
}
