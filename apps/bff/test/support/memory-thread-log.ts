import type { BaseEvent } from '@ag-ui/client';
import type { LoggedEvent, ThreadLog } from '../../src/features/chat/runner/thread-log.js';

/** In-process `ThreadLog` with the Redis log's contract (thread-log.test.ts runs both), minus TTLs. */
export class MemoryThreadLog implements ThreadLog {
  private readonly owners = new Map<string, string>();
  private readonly runs = new Map<string, string>();
  private readonly events = new Map<string, LoggedEvent[]>();
  private readonly seqs = new Map<string, number>();
  private readonly waiters = new Set<() => void>();

  async claim(threadId: string, owner: string): Promise<boolean> {
    const current = this.owners.get(threadId);
    if (current === undefined) this.owners.set(threadId, owner);
    return (current ?? owner) === owner;
  }

  async ownerOf(threadId: string): Promise<string | null> {
    return this.owners.get(threadId) ?? null;
  }

  async acquireRun(threadId: string, runId: string): Promise<boolean> {
    if (this.runs.has(threadId)) return false;
    this.runs.set(threadId, runId);
    return true;
  }

  async renewRun(): Promise<void> {}

  async releaseRun(threadId: string, runId: string): Promise<void> {
    if (this.runs.get(threadId) === runId) this.runs.delete(threadId);
  }

  async activeRun(threadId: string): Promise<string | null> {
    return this.runs.get(threadId) ?? null;
  }

  async append(threadId: string, event: BaseEvent): Promise<number> {
    const seq = (this.seqs.get(threadId) ?? 0) + 1;
    this.seqs.set(threadId, seq);
    this.events.set(threadId, [...(this.events.get(threadId) ?? []), { seq, event: structuredClone(event) }]);
    for (const wake of this.waiters) wake();
    return seq;
  }

  async readAfter(threadId: string, afterSeq: number): Promise<LoggedEvent[]> {
    return (this.events.get(threadId) ?? []).filter((entry) => entry.seq > afterSeq);
  }

  async *follow(threadId: string, afterSeq: number, waitMs: number, signal: AbortSignal) {
    let cursor = afterSeq;
    while (!signal.aborted) {
      let batch = await this.readAfter(threadId, cursor);
      if (batch.length === 0) {
        await this.waitForAppend(waitMs, signal);
        batch = await this.readAfter(threadId, cursor);
      }
      if (signal.aborted) return;
      cursor = batch.at(-1)?.seq ?? cursor;
      yield batch;
    }
  }

  /** Test hook: the replay window passed (the Redis keys expired). */
  expireEvents(threadId: string): void {
    this.events.delete(threadId);
  }

  /** Test hook: the process running the thread died, so its lease lapsed. */
  dropLease(threadId: string): void {
    this.runs.delete(threadId);
    for (const wake of this.waiters) wake();
  }

  private waitForAppend(waitMs: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, waitMs);
      this.waiters.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }
}
