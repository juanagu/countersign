import { CopilotKitCoreErrorCode } from '@copilotkit/react-core/v2';
import { describe, expect, it, vi } from 'vitest';
import { createReconnector, isStreamBreak, type ReconnectorDeps } from '../../../src/features/chat/lib/reconnector';

function harness(overrides: Partial<ReconnectorDeps> = {}) {
  const timers: { ms: number; run: () => void }[] = [];
  const onlineWaiters: (() => void)[] = [];
  const deps: ReconnectorDeps = {
    connect: vi.fn(async () => undefined),
    isOnline: () => true,
    whenOnline: (callback) => {
      onlineWaiters.push(callback);
      return () => undefined;
    },
    after: (ms, run) => {
      timers.push({ ms, run });
      return () => undefined;
    },
    delaysMs: [10, 20, 40],
    ...overrides,
  };
  const flush = async () => {
    const due = timers.splice(0);
    for (const timer of due) timer.run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return due.map((t) => t.ms);
  };
  return { deps, timers, onlineWaiters, flush, reconnector: createReconnector(deps) };
}

describe('createReconnector', () => {
  it('reconnects once per break, however many errors the break reports', async () => {
    const { deps, reconnector, flush } = harness();
    reconnector.streamBroke();
    reconnector.streamBroke();
    expect(await flush()).toEqual([10]);
    expect(deps.connect).toHaveBeenCalledTimes(1);
  });

  it('backs off while the connect keeps failing, and gives up after the last delay', async () => {
    const connect = vi.fn(async () => {
      throw new Error('offline');
    });
    const { reconnector, flush } = harness({ connect });
    reconnector.streamBroke();
    const waits = [...(await flush()), ...(await flush()), ...(await flush()), ...(await flush())];
    expect(waits).toEqual([10, 20, 40]);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('waits for the network when the browser is offline', async () => {
    const { deps, reconnector, onlineWaiters, timers } = harness({ isOnline: () => false });
    reconnector.streamBroke();
    expect(timers).toHaveLength(0);
    onlineWaiters[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deps.connect).toHaveBeenCalledTimes(1);
  });

  it('starts over after a successful reconnect', async () => {
    const { reconnector, flush } = harness();
    reconnector.streamBroke();
    await flush();
    reconnector.streamBroke();
    expect(await flush()).toEqual([10]);
  });

  it('reports retrying, then idle once the connect succeeds', async () => {
    const states: string[] = [];
    const { reconnector, flush } = harness({ onStateChange: (state) => states.push(state) });
    reconnector.streamBroke();
    expect(states).toEqual(['retrying']);
    await flush();
    expect(states).toEqual(['retrying', 'idle']);
  });

  it('reports waiting-online while the browser is offline, then retrying once it is back', async () => {
    const states: string[] = [];
    const { reconnector, onlineWaiters } = harness({ isOnline: () => false, onStateChange: (s) => states.push(s) });
    reconnector.streamBroke();
    expect(states).toEqual(['waiting-online']);
    onlineWaiters[0]?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).toEqual(['waiting-online', 'retrying', 'idle']);
  });

  it('goes idle when it gives up, and when it is disposed mid-wait', async () => {
    const states: string[] = [];
    const connect = vi.fn(async () => {
      throw new Error('offline');
    });
    const { reconnector, flush } = harness({ connect, delaysMs: [10], onStateChange: (s) => states.push(s) });
    reconnector.streamBroke();
    await flush();
    expect(states.at(-1)).toBe('idle');

    const second: string[] = [];
    const other = harness({ onStateChange: (s) => second.push(s) });
    other.reconnector.streamBroke();
    other.reconnector.dispose();
    expect(second).toEqual(['retrying', 'idle']);
  });

  it('starts a fresh cycle on a break after it gave up', async () => {
    const states: string[] = [];
    const connect = vi.fn<() => Promise<void>>(async () => {
      throw new Error('offline');
    });
    const { reconnector, flush } = harness({ connect, onStateChange: (s) => states.push(s) });
    reconnector.streamBroke();
    for (let i = 0; i < 4; i += 1) await flush();
    expect(states.at(-1)).toBe('idle');

    connect.mockImplementation(async () => undefined);
    reconnector.streamBroke();
    expect(states.at(-1)).toBe('retrying');
    expect(await flush()).toEqual([10]);
    expect(connect).toHaveBeenCalledTimes(4);
    expect(states.at(-1)).toBe('idle');
  });

  it('reconnects when the browser comes back online after it gave up', async () => {
    const states: string[] = [];
    const connect = vi.fn<() => Promise<void>>(async () => {
      throw new Error('offline');
    });
    const { reconnector, flush, onlineWaiters } = harness({
      connect,
      delaysMs: [10],
      onStateChange: (s) => states.push(s),
    });
    reconnector.streamBroke();
    await flush();
    expect(states).toEqual(['retrying', 'idle']);

    connect.mockImplementation(async () => undefined);
    onlineWaiters.at(-1)?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connect).toHaveBeenCalledTimes(2);
    expect(states).toEqual(['retrying', 'idle', 'retrying', 'idle']);
  });

  it('counts a connect that reported a break as failed, as CopilotKit resolves it', async () => {
    const holder: { reconnector?: { streamBroke(): void } } = {};
    const connect = vi.fn(async () => holder.reconnector?.streamBroke());
    const { reconnector, flush } = harness({ connect });
    holder.reconnector = reconnector;
    reconnector.streamBroke();
    const waits = [...(await flush()), ...(await flush()), ...(await flush()), ...(await flush())];
    expect(waits).toEqual([10, 20, 40]);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it('resumes an offline break with one connect that follows the run to its end, leaving nothing armed', async () => {
    const states: string[] = [];
    let finishRun: () => void = () => undefined;
    const connect = vi.fn(() => new Promise<void>((resolve) => (finishRun = resolve)));
    const { reconnector, onlineWaiters, timers } = harness({
      connect,
      isOnline: () => false,
      onStateChange: (s) => states.push(s),
    });
    reconnector.streamBroke();
    onlineWaiters.shift()?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).toEqual(['waiting-online', 'retrying']);

    finishRun();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(states).toEqual(['waiting-online', 'retrying', 'idle']);
    expect(onlineWaiters).toHaveLength(0);
    expect(timers).toHaveLength(0);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('only reacts to failed requests, not to errors the bot reported', () => {
    expect(isStreamBreak(CopilotKitCoreErrorCode.AGENT_RUN_FAILED)).toBe(true);
    expect(isStreamBreak(CopilotKitCoreErrorCode.AGENT_CONNECT_FAILED)).toBe(true);
    expect(isStreamBreak(CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT)).toBe(false);
  });
});
