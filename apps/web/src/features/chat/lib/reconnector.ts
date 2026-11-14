import { CopilotKitCoreErrorCode } from '@copilotkit/react-core/v2';

/** A failed run or connect request: the stream broke (offline, BFF gone), as opposed to an error the bot sent. */
const STREAM_BREAKS: ReadonlySet<CopilotKitCoreErrorCode> = new Set([
  CopilotKitCoreErrorCode.AGENT_RUN_FAILED,
  CopilotKitCoreErrorCode.AGENT_CONNECT_FAILED,
]);

export function isStreamBreak(code: CopilotKitCoreErrorCode): boolean {
  return STREAM_BREAKS.has(code);
}

/** Waits between attempts; after the last one the chat stays as it is until the next break or `online` event. */
export const RECONNECT_DELAYS_MS: readonly number[] = [500, 1_000, 2_000, 4_000, 8_000];

/** `waiting-online`: the browser is offline, so nothing is tried yet. `retrying`: a reconnect is scheduled or running. */
export type ReconnectState = 'idle' | 'waiting-online' | 'retrying';

export interface ReconnectorDeps {
  /** Re-attaches to the thread: the BFF replays it and follows the live run. */
  connect: () => Promise<void>;
  isOnline: () => boolean;
  /** Calls back once the browser is online again; returns a cancel. */
  whenOnline: (callback: () => void) => () => void;
  /** Calls back after `ms`; returns a cancel. */
  after: (ms: number, callback: () => void) => () => void;
  delaysMs?: readonly number[];
  onStateChange?: (state: ReconnectState) => void;
}

export interface Reconnector {
  streamBroke(): void;
  dispose(): void;
}

/**
 * Reconnects a broken stream with backoff, waiting for the network when the browser is offline. After the last
 * delay it stops until the next break or the browser's next `online` event, either of which starts over.
 */
export function createReconnector(deps: ReconnectorDeps): Reconnector {
  const delays = deps.delaysMs ?? RECONNECT_DELAYS_MS;
  let attempt = 0;
  let pending: (() => void) | null = null;
  let watchingOnline: (() => void) | null = null;
  let connecting = false;
  let brokeWhileConnecting = false;
  let disposed = false;
  let state: ReconnectState = 'idle';

  function setState(next: ReconnectState) {
    if (next === state) return;
    state = next;
    deps.onStateChange?.(next);
  }

  // CopilotKit's connectAgent reports a failed connect as an error and resolves, so a break during it is a failure.
  async function reconnect() {
    pending = null;
    connecting = true;
    brokeWhileConnecting = false;
    setState('retrying');
    let failed = false;
    try {
      await deps.connect();
    } catch {
      failed = true;
    }
    connecting = false;
    if (disposed) return;
    if (failed || brokeWhileConnecting) return scheduleRetry();
    attempt = 0;
    setState('idle');
  }

  function giveUp() {
    attempt = 0;
    setState('idle');
    watchingOnline = deps.whenOnline(() => {
      watchingOnline = null;
      void reconnect();
    });
  }

  function scheduleRetry() {
    if (attempt >= delays.length) return giveUp();
    const delay = delays[attempt] ?? 0;
    attempt += 1;
    if (deps.isOnline()) {
      pending = deps.after(delay, () => void reconnect());
      setState('retrying');
    } else {
      pending = deps.whenOnline(() => void reconnect());
      setState('waiting-online');
    }
  }

  function stopWatchingOnline() {
    watchingOnline?.();
    watchingOnline = null;
  }

  function streamBroke() {
    if (disposed || pending) return;
    // A failed connect reports itself too; the connect's outcome schedules the one retry.
    if (connecting) {
      brokeWhileConnecting = true;
      return;
    }
    stopWatchingOnline();
    scheduleRetry();
  }

  return {
    streamBroke,
    dispose() {
      disposed = true;
      pending?.();
      pending = null;
      stopWatchingOnline();
      setState('idle');
    },
  };
}
