import { randomUUID } from 'node:crypto';
import { EventType, type BaseEvent, type Message } from '@ag-ui/client';
import { ɵSERVER_THREAD_OWNER } from '@copilotkit/runtime/v2';
import { Observable } from 'rxjs';
import { RunState } from './run-state.js';
import type { ThreadHistory } from './thread-history.js';
import type { LoggedEvent, ThreadLog } from './thread-log.js';

export interface ReplayDeps {
  log: ThreadLog;
  history: ThreadHistory;
  /** How long one wait for live events blocks before the lease is checked again. */
  followWaitMs: number;
}

type Emit = (event: BaseEvent) => void;
type RunStartedEvent = BaseEvent & { input?: { messages?: Message[] } };

const hasHistory = (owner: string) => owner !== '' && owner !== ɵSERVER_THREAD_OWNER;

function emitSnapshot(threadId: string, messages: Message[], emit: Emit) {
  const runId = `restore-${randomUUID()}`;
  emit({ type: EventType.RUN_STARTED, threadId, runId } as BaseEvent);
  emit({ type: EventType.MESSAGES_SNAPSHOT, messages } as BaseEvent);
  emit({ type: EventType.RUN_FINISHED, threadId, runId } as BaseEvent);
}

/** Past the replay window, the bot's stored conversation comes back as one snapshot. */
async function emitRestored(history: ThreadHistory, threadId: string, owner: string, emit: Emit) {
  if (!hasHistory(owner)) return;
  const messages = await history.messagesFor(threadId, owner);
  if (messages.length > 0) emitSnapshot(threadId, messages, emit);
}

/**
 * A run started after the window lapsed opens a fresh log, and its RUN_STARTED carries the earlier turns only as
 * the client held them: text, no cards. Those turns come from stored history instead, and the first logged run
 * keeps just the turn it was started for, so the client sees each message once.
 */
async function restoreEarlierTurns(
  history: ThreadHistory,
  threadId: string,
  owner: string,
  logged: LoggedEvent[],
  emit: Emit,
): Promise<LoggedEvent[]> {
  const [first, ...rest] = logged;
  const started = first?.event as RunStartedEvent | undefined;
  if (first === undefined || started?.type !== EventType.RUN_STARTED || !hasHistory(owner)) return logged;
  const carried = started.input?.messages ?? [];
  const turnStart = carried.findLastIndex((message) => message.role === 'user');
  if (turnStart <= 0) return logged;
  const stored = await history.messagesFor(threadId, owner);
  const earlier = stored.findIndex((message) => message.id === carried[turnStart]?.id);
  if (earlier <= 0) return logged;
  emitSnapshot(threadId, stored.slice(0, earlier), emit);
  const trimmed = { ...started, input: { ...started.input, messages: carried.slice(turnStart) } };
  return [{ seq: first.seq, event: trimmed as BaseEvent }, ...rest];
}

async function followLive(
  deps: ReplayDeps,
  threadId: string,
  afterSeq: number,
  state: RunState,
  emit: Emit,
  signal: AbortSignal,
) {
  let seq = afterSeq;
  const forward = (batch: { seq: number; event: BaseEvent }[]) => {
    for (const entry of batch) {
      state.observe(entry.event);
      emit(entry.event);
      seq = entry.seq;
    }
  };
  for await (const batch of deps.log.follow(threadId, seq, deps.followWaitMs, signal)) {
    forward(batch);
    if (batch.length > 0 && !state.isOpen) return;
    if (batch.length > 0 || (await deps.log.activeRun(threadId)) !== null) continue;
    // The lease is gone: whatever the run wrote is in the log. Drain it, then close a run its process left open.
    forward(await deps.log.readAfter(threadId, seq));
    for (const event of state.closingEvents()) emit(event);
    return;
  }
}

async function streamThread(deps: ReplayDeps, threadId: string, owner: string, emit: Emit, signal: AbortSignal) {
  const holder = await deps.log.ownerOf(threadId);
  if (holder !== null && holder !== owner) return; // Another user's thread is unknown here: nothing at all.
  const fullLog = holder === null ? [] : await deps.log.readAfter(threadId, 0);
  if (fullLog.length === 0) await emitRestored(deps.history, threadId, owner, emit);
  const logged = await restoreEarlierTurns(deps.history, threadId, owner, fullLog, emit);
  const state = new RunState();
  for (const { event } of logged) {
    state.observe(event);
    emit(event);
  }
  if (holder === null || (!state.isOpen && (await deps.log.activeRun(threadId)) === null)) return;
  await followLive(deps, threadId, logged.at(-1)?.seq ?? 0, state, emit, signal);
}

/**
 * The thread as a client should rebuild it: every logged event in order, then the live run's events as
 * they are written, read from the last replayed `seq` so nothing repeats and nothing is skipped.
 */
export function replayThread(deps: ReplayDeps, threadId: string, owner: string): Observable<BaseEvent> {
  return new Observable<BaseEvent>((subscriber) => {
    const abort = new AbortController();
    streamThread(deps, threadId, owner, (event) => subscriber.next(event), abort.signal).then(
      () => subscriber.complete(),
      (error: unknown) => subscriber.error(error),
    );
    return () => abort.abort();
  });
}
