import { randomUUID } from 'node:crypto';
import { HttpAgent, type BaseEvent, type Message } from '@ag-ui/client';
import { lastValueFrom, toArray } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import { DurableAgentRunner } from '../../../../src/features/chat/runner/durable-agent-runner.js';
import { LOST_RUN_MESSAGE } from '../../../../src/features/chat/runner/run-state.js';
import type { ThreadHistory } from '../../../../src/features/chat/runner/thread-history.js';
import { silentLogger } from '../../../support/build-app.js';
import { startFakeBot, type FakeBot } from '../../../support/fake-bot.js';
import { MemoryThreadLog } from '../../../support/memory-thread-log.js';

class FakeHistory implements ThreadHistory {
  readonly asked: string[] = [];
  constructor(private readonly stored: Record<string, Message[]> = {}) {}
  async messagesFor(threadId: string, owner: string): Promise<Message[]> {
    this.asked.push(owner);
    return this.stored[`${owner}:${threadId}`] ?? [];
  }
}

const input = (threadId: string) => ({
  threadId,
  runId: randomUUID(),
  messages: [{ id: randomUUID(), role: 'user' as const, content: 'hola' }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

function setup(history = new FakeHistory()) {
  const log = new MemoryThreadLog();
  const runner = new DurableAgentRunner({ log, history, logger: silentLogger, followWaitMs: 50, leaseRenewMs: 20 });
  return { log, runner, history };
}

const collect = (events: ReturnType<DurableAgentRunner['connect']>) => lastValueFrom(events.pipe(toArray()));

describe('DurableAgentRunner', () => {
  let bot: FakeBot | undefined;
  afterEach(() => bot?.server.close());

  it('reports a run as running only to its owner, and stops it only for its owner', async () => {
    bot = await startFakeBot({ delayMs: 30 });
    const { runner } = setup();
    const threadId = randomUUID();
    const events = runner.run({
      threadId,
      agent: new HttpAgent({ url: bot.url }),
      input: input(threadId),
      ownerId: 'ana',
    });
    const done = lastValueFrom(events.pipe(toArray()));
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(await runner.isRunning({ threadId, ownerId: 'ana' })).toBe(true);
    expect(await runner.isRunning({ threadId, ownerId: 'juan' })).toBe(false);
    expect(await runner.stop({ threadId, ownerId: 'juan' })).toBe(false);
    expect(await runner.stop({ threadId, ownerId: 'ana' })).toBe(true);

    const all = await done;
    expect(['RUN_FINISHED', 'RUN_ERROR']).toContain(all.at(-1)?.type);
    expect(all.filter((e) => e.type === 'TEXT_MESSAGE_CONTENT').length).toBeLessThan(20);
    expect(await runner.isRunning({ threadId, ownerId: 'ana' })).toBe(false);
  });

  it('refuses a second run while the thread has one in flight', async () => {
    bot = await startFakeBot({ delayMs: 20 });
    const { runner } = setup();
    const threadId = randomUUID();
    const { url } = bot;
    const agent = () => new HttpAgent({ url });
    const first = lastValueFrom(
      runner.run({ threadId, agent: agent(), input: input(threadId), ownerId: 'ana' }).pipe(toArray()),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = lastValueFrom(runner.run({ threadId, agent: agent(), input: input(threadId), ownerId: 'ana' }));
    await expect(second).rejects.toMatchObject({ code: 'THREAD_ALREADY_RUNNING' });
    await first;
  });

  it('closes a run whose process died: open text ends and a RUN_ERROR follows', async () => {
    const { log, runner } = setup();
    const threadId = randomUUID();
    await log.claim(threadId, 'ana');
    await log.acquireRun(threadId, 'r1');
    for (const event of [
      { type: 'RUN_STARTED', threadId, runId: 'r1' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hola' },
    ]) {
      await log.append(threadId, event as BaseEvent);
    }
    const replay = collect(runner.connect({ threadId, ownerId: 'ana' }));
    log.dropLease(threadId);

    const types = (await replay).map((e) => e.type);
    expect(types).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_ERROR',
    ]);
    expect((await replay).at(-1)).toMatchObject({ message: LOST_RUN_MESSAGE });
  });

  it('past the replay window restores the owner’s stored conversation as one snapshot', async () => {
    const threadId = randomUUID();
    const stored: Message[] = [
      { id: 'u1', role: 'user', content: 'hola' },
      { id: 'a1', role: 'assistant', content: 'Hola, Ana.' },
    ];
    const { runner, history } = setup(new FakeHistory({ [`ana:${threadId}`]: stored }));

    const events = await collect(runner.connect({ threadId, ownerId: 'ana' }));
    expect(events.map((e) => e.type)).toEqual(['RUN_STARTED', 'MESSAGES_SNAPSHOT', 'RUN_FINISHED']);
    expect((events[1] as unknown as { messages: Message[] }).messages).toEqual(stored);

    // Juan asks for the same thread id: the history is looked up under his identity, so he gets nothing.
    expect(await collect(runner.connect({ threadId, ownerId: 'juan' }))).toEqual([]);
    expect(history.asked).toEqual(['ana', 'juan']);
  });

  it('a log started after the window lapsed gets its earlier turns, cards included, from stored history', async () => {
    const threadId = randomUUID();
    const receipt = { id: 'card-1', role: 'activity', activityType: 'bank-template', content: { template: 'r' } };
    const stored = [
      { id: 'u1', role: 'user', content: 'mandale 50.000 a ana' },
      receipt,
      { id: 'a1-stored', role: 'assistant', content: 'Listo.' },
      { id: 'u2', role: 'user', content: '¿cuánto saldo tengo?' },
      { id: 'a2-stored', role: 'assistant', content: 'Tenés $ 1.000.' },
    ] as Message[];
    const { log, runner } = setup(new FakeHistory({ [`ana:${threadId}`]: stored }));
    await log.claim(threadId, 'ana');
    const carried = [stored[0], { id: 'a1-client', role: 'assistant', content: 'Listo.' }, stored[3]];
    const run = { threadId, runId: 'r2' };
    for (const event of [
      { type: 'RUN_STARTED', ...run, input: { ...input(threadId), messages: carried } },
      { type: 'TEXT_MESSAGE_START', messageId: 'a2', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'a2', delta: 'Tenés $ 1.000.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'a2' },
      { type: 'RUN_FINISHED', ...run },
    ]) {
      await log.append(threadId, event as BaseEvent);
    }

    const events = await collect(runner.connect({ threadId, ownerId: 'ana' }));

    expect(events.map((e) => e.type).slice(0, 4)).toEqual([
      'RUN_STARTED',
      'MESSAGES_SNAPSHOT',
      'RUN_FINISHED',
      'RUN_STARTED',
    ]);
    expect((events[1] as unknown as { messages: Message[] }).messages).toEqual(stored.slice(0, 3));
    const replayed = events[3] as unknown as { input: { messages: Message[] } };
    expect(replayed.input.messages.map((m) => m.id)).toEqual(['u2']);
  });

  it('never asks for history on a thread another user holds', async () => {
    const { log, runner, history } = setup();
    const threadId = randomUUID();
    await log.claim(threadId, 'ana');
    expect(await collect(runner.connect({ threadId, ownerId: 'juan' }))).toEqual([]);
    expect(history.asked).toEqual([]);
    expect(await runner.isThreadAccessible(threadId, { ownerId: 'juan' })).toBe(false);
    expect(await runner.isThreadAccessible(threadId, { ownerId: 'ana' })).toBe(true);
  });
  it('a resumed approval logs and replays its answer without the step-up token', async () => {
    bot = await startFakeBot({ deltas: ['listo'], delayMs: 1 });
    const { log, runner } = setup();
    const threadId = randomUUID();
    const stepUpToken = 'eyJhbGciOiJFUzI1NiJ9.step-up.signature';
    const answer = { approved: true, editedArgs: { draft_id: 'd1', step_up_token: stepUpToken } };
    const asked = { id: randomUUID(), role: 'user' as const, content: 'transferí 100 a Juan' };
    const call = {
      id: randomUUID(),
      role: 'assistant' as const,
      toolCalls: [
        {
          id: 'call-1',
          type: 'function' as const,
          function: { name: 'execute_transfer', arguments: '{"draft_id":"d1"}' },
        },
      ],
    };
    // What CopilotKit 1.87 `useInterrupt.resolve` sends: the answer as a tool message, then the same answer in `resume`.
    const answered = { id: randomUUID(), role: 'tool' as const, toolCallId: 'call-1', content: JSON.stringify(answer) };
    const resumed = {
      ...input(threadId),
      messages: [asked, call, answered],
      resume: [{ interruptId: 'int-call-1', status: 'resolved' as const, payload: answer }],
    };
    // The runtime hands the runner an agent that already holds the request's messages.
    const agent = new HttpAgent({ url: bot.url, threadId, initialMessages: resumed.messages });
    const live = await collect(runner.run({ threadId, agent, input: resumed, ownerId: 'ana' }));
    const logged = (await log.readAfter(threadId, 0)).map((entry) => entry.event);
    const replayed = await collect(runner.connect({ threadId, ownerId: 'ana' }));

    for (const events of [live, logged, replayed]) {
      expect(JSON.stringify(events)).not.toContain('step_up_token');
      expect(JSON.stringify(events)).not.toContain(stepUpToken);
    }
    const started = replayed[0] as unknown as { input: typeof resumed };
    expect(started.input.resume[0]?.payload).toEqual({ approved: true });
    expect(started.input.messages).toEqual([asked, call]);
    expect(bot.requests[0]?.messages).toContainEqual(answered);
    expect(bot.requests[0]?.resume).toEqual(resumed.resume);
  });
});
