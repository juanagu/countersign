import { CopilotKitCoreErrorCode } from '@copilotkit/react-core/v2';

/** A failed run or connect request: the stream broke (offline, BFF gone), as opposed to an error the bot sent. */
const STREAM_BREAKS: ReadonlySet<CopilotKitCoreErrorCode> = new Set([
  CopilotKitCoreErrorCode.AGENT_RUN_FAILED,
  CopilotKitCoreErrorCode.AGENT_CONNECT_FAILED,
]);

export function isStreamBreak(code: CopilotKitCoreErrorCode): boolean {
  return STREAM_BREAKS.has(code);
}

/** Waits between attempts; after the last one the chat stays as it is until the next break. */
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

/** Reconnects a broken stream with backoff, waiting for the network when the browser is offline. */
export function createReconnector(deps: ReconnectorDeps): Reconnector {
  const delays = deps.delaysMs ?? RECONNECT_DELAYS_MS;
  let attempt = 0;
  let pending: (() => void) | null = null;
  let connecting = false;
  let disposed = false;
  let state: ReconnectState = 'idle';

  function setState(next: ReconnectState) {
    if (next === state) return;
    state = next;
    deps.onStateChange?.(next);
  }

  async function reconnect() {
    pending = null;
    connecting = true;
    setState('retrying');
    try {
      await deps.connect();
      attempt = 0;
    } catch {
      connecting = false;
      streamBroke();
      return;
    }
    connecting = false;
    setState('idle');
  }

  function streamBroke() {
    // A failed connect reports itself too; one retry is already on its way.
    if (disposed || pending || connecting) return;
    if (attempt >= delays.length) return setState('idle');
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

  return {
    streamBroke,
    dispose() {
      disposed = true;
      pending?.();
      pending = null;
      setState('idle');
    },
  };
}
