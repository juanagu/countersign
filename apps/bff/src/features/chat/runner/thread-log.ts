import type { BaseEvent } from '@ag-ui/client';

/** One AG-UI event in a thread's log, with its position. `seq` grows by one per event, per thread. */
export interface LoggedEvent {
  seq: number;
  event: BaseEvent;
}

/**
 * The thread state the runner keeps outside the process: the owner, the run lease and the event log.
 * Implemented on Redis; tests use an in-memory copy that passes the same contract suite.
 */
export interface ThreadLog {
  /** Records `owner` on a thread nobody holds. True when `owner` holds it now, false for another owner. */
  claim(threadId: string, owner: string): Promise<boolean>;
  ownerOf(threadId: string): Promise<string | null>;
  /** Takes the thread's run lease for `runId`. False while another run holds it. */
  acquireRun(threadId: string, runId: string): Promise<boolean>;
  /** Extends the lease while the run lives; a lease that is not renewed lapses, so a dead process frees it. */
  renewRun(threadId: string, runId: string): Promise<void>;
  releaseRun(threadId: string, runId: string): Promise<void>;
  activeRun(threadId: string): Promise<string | null>;
  /** Appends one event and returns its `seq`. Each append restarts the replay window. */
  append(threadId: string, event: BaseEvent): Promise<number>;
  /** Every logged event with a `seq` above `afterSeq`, oldest first. */
  readAfter(threadId: string, afterSeq: number): Promise<LoggedEvent[]>;
  /**
   * Batches of new events after `afterSeq`, each batch continuing where the last ended. Yields an empty
   * batch when `waitMs` passes with nothing new, so the caller can check the lease. Ends on `signal`.
   */
  follow(threadId: string, afterSeq: number, waitMs: number, signal: AbortSignal): AsyncIterable<LoggedEvent[]>;
}
