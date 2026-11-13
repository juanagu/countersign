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

  it('only reacts to failed requests, not to errors the bot reported', () => {
    expect(isStreamBreak(CopilotKitCoreErrorCode.AGENT_RUN_FAILED)).toBe(true);
    expect(isStreamBreak(CopilotKitCoreErrorCode.AGENT_CONNECT_FAILED)).toBe(true);
    expect(isStreamBreak(CopilotKitCoreErrorCode.AGENT_RUN_ERROR_EVENT)).toBe(false);
  });
});
