import { randomUUID } from 'node:crypto';
import type { ServerType } from '@hono/node-server';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import type { ThreadLog } from '../../../src/features/chat/runner/thread-log.js';
import { buildTestApp, loginCookie } from '../../support/build-app.js';
import { DEFAULT_DELTAS, startFakeBot, type FakeBot } from '../../support/fake-bot.js';
import { MemoryThreadLog } from '../../support/memory-thread-log.js';
import { connectTestRedis, redisLogOrThrow } from '../../support/redis.js';
import { serveApp } from '../../support/serve-app.js';
import { foldText, parseSse, readUntil, type AguiEvent } from '../../support/sse.js';

const RUN = '/copilotkit/agent/default/run';
const CONNECT = '/copilotkit/agent/default/connect';
const EXPECTED_TEXT = DEFAULT_DELTAS.join('');

const redis = await connectTestRedis();
afterAll(() => redis?.destroy());

function body(threadId: string, runId = randomUUID()) {
  return JSON.stringify({
    threadId,
    runId,
    messages: [{ id: `u-${runId}`, role: 'user', content: 'contame' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
}

const init = (cookie: string, payload: string, signal?: AbortSignal): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie },
  body: payload,
  ...(signal ? { signal } : {}),
});

const contentDeltas = (events: readonly AguiEvent[]) => events.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').length;

interface Stack {
  base: string;
  cookie: string;
  bot: FakeBot;
  servers: ServerType[];
}

async function startStack(log: ThreadLog, user = 'ana'): Promise<Stack> {
  const bot = await startFakeBot();
  const { app } = await buildTestApp(bot.url, { threadLog: log });
  const { base, server } = await serveApp(app);
  return { base, cookie: await loginCookie(app, user), bot, servers: [server, bot.server] };
}

const cuts: [string, (events: AguiEvent[]) => boolean][] = [
  ['before the first delta', (events) => events.some((e) => e.type === 'RUN_STARTED')],
  ['mid-text', (events) => contentDeltas(events) >= DEFAULT_DELTAS.length / 2],
  ['just before the end', (events) => contentDeltas(events) >= DEFAULT_DELTAS.length - 1],
];

const logs: [string, boolean, () => ThreadLog][] = [
  ['memory', true, () => new MemoryThreadLog()],
  ['redis', redis !== null, () => redisLogOrThrow(redis)],
];

describe.each(logs)('resumable stream (%s log)', (_, available, makeLog) => {
  const run = it.runIf(available);
  let open: ServerType[] = [];
  afterEach(() => {
    for (const server of open) server.close();
    open = [];
  });

  run.each(cuts)('a connection cut %s resumes with the exact text, nothing lost or repeated', async (_, cut) => {
    const stack = await startStack(makeLog());
    open = stack.servers;
    const threadId = randomUUID();
    const abort = new AbortController();

    const res = await fetch(stack.base + RUN, init(stack.cookie, body(threadId), abort.signal));
    const before = await readUntil(res, abort, cut);
    const replay = parseSse(await (await fetch(stack.base + CONNECT, init(stack.cookie, body(threadId)))).text());

    expect(contentDeltas(before)).toBeLessThan(DEFAULT_DELTAS.length);
    expect([...foldText(replay).values()]).toEqual([EXPECTED_TEXT]);
    expect(contentDeltas(replay)).toBe(DEFAULT_DELTAS.length);
    expect(replay.filter((e) => e.type === 'RUN_STARTED')).toHaveLength(1);
    expect(replay.at(-1)?.type).toBe('RUN_FINISHED');
    expect(stack.bot.runs).toBe(1);
  });

  run('a reload after the run finished replays the whole thread, both turns in order', async () => {
    const stack = await startStack(makeLog());
    open = stack.servers;
    const threadId = randomUUID();
    for (let turn = 0; turn < 2; turn += 1)
      await (await fetch(stack.base + RUN, init(stack.cookie, body(threadId)))).text();

    const replay = parseSse(await (await fetch(stack.base + CONNECT, init(stack.cookie, body(threadId)))).text());
    expect([...foldText(replay).values()]).toEqual([EXPECTED_TEXT, EXPECTED_TEXT]);
    const users = replay
      .filter((e) => e.type === 'RUN_STARTED')
      .map((e) => (e.input as { messages: { id: string }[] }).messages[0]?.id);
    expect(users).toHaveLength(2);
  });

  run('a restarted BFF (new process, new keys) replays a thread the old one ran', async () => {
    const log = makeLog();
    const stack = await startStack(log);
    open = stack.servers;
    const threadId = randomUUID();
    await (await fetch(stack.base + RUN, init(stack.cookie, body(threadId)))).text();

    const restarted = await buildTestApp(stack.bot.url, { threadLog: log });
    const cookie = await loginCookie(restarted.app, 'ana');
    const replay = parseSse(await (await restarted.app.request(CONNECT, init(cookie, body(threadId)))).text());
    expect([...foldText(replay).values()]).toEqual([EXPECTED_TEXT]);
  });

  run("another user's connect gets nothing, not even while the run is live", async () => {
    const log = makeLog();
    const stack = await startStack(log);
    open = stack.servers;
    const { app } = await buildTestApp(stack.bot.url, { threadLog: log });
    const juan = await loginCookie(app, 'juan');
    const threadId = randomUUID();
    const running = fetch(stack.base + RUN, init(stack.cookie, body(threadId))).then((r) => r.text());

    await new Promise((resolve) => setTimeout(resolve, 60));
    const theirs = await (await app.request(CONNECT, init(juan, body(threadId)))).text();
    await running;
    const after = await (await app.request(CONNECT, init(juan, body(threadId)))).text();

    expect(parseSse(theirs)).toEqual([]);
    expect(parseSse(after)).toEqual([]);
    expect(stack.bot.historyCallers).toEqual([]);
  });
});
