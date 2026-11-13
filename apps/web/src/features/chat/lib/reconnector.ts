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

export interface ReconnectorDeps {
  /** Re-attaches to the thread: the BFF replays it and follows the live run. */
  connect: () => Promise<void>;
  isOnline: () => boolean;
  /** Calls back once the browser is online again; returns a cancel. */
  whenOnline: (callback: () => void) => () => void;
  /** Calls back after `ms`; returns a cancel. */
  after: (ms: number, callback: () => void) => () => void;
  delaysMs?: readonly number[];
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

  async function reconnect() {
    pending = null;
    connecting = true;
    try {
      await deps.connect();
      attempt = 0;
    } catch {
      connecting = false;
      streamBroke();
      return;
    }
    connecting = false;
  }

  function streamBroke() {
    // A failed connect reports itself too; one retry is already on its way.
    if (disposed || pending || connecting || attempt >= delays.length) return;
    const delay = delays[attempt] ?? 0;
    attempt += 1;
    pending = deps.isOnline() ? deps.after(delay, () => void reconnect()) : deps.whenOnline(() => void reconnect());
  }

  return {
    streamBroke,
    dispose() {
      disposed = true;
      pending?.();
      pending = null;
    },
  };
}
