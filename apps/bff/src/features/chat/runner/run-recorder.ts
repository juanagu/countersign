import { EventType, type AbstractAgent, type BaseEvent, type RunAgentInput } from '@ag-ui/client';
import {
  finalizeRunEvents,
  ThreadAccessDeniedError,
  ThreadAlreadyRunningError,
  ɵresolveThreadOwner,
  type AgentRunnerRunRequest,
} from '@copilotkit/runtime/v2';
import type { Logger } from 'pino';
import { ReplaySubject, type Observable } from 'rxjs';
import { RunState } from './run-state.js';
import type { ThreadLog } from './thread-log.js';

const AGENT_FAILED_MESSAGE = 'Agent run failed';

/** A run this process is executing, so `stop` can abort it. */
export interface ActiveRun {
  runId: string;
  agent: AbstractAgent;
  stopRequested: boolean;
}

export interface RecorderDeps {
  log: ThreadLog;
  logger: Logger;
  active: Map<string, ActiveRun>;
  leaseRenewMs: number;
}

/** Writes events to the log in order. After a failed write it stops, so the log stays a gap-free prefix. */
class OrderedWriter {
  private tail: Promise<void> = Promise.resolve();
  private failed = false;

  constructor(
    private readonly deps: RecorderDeps,
    private readonly threadId: string,
  ) {}

  write(event: BaseEvent): void {
    this.tail = this.tail.then(async () => {
      if (this.failed) return;
      try {
        await this.deps.log.append(this.threadId, event);
      } catch (error) {
        this.failed = true;
        this.deps.logger.error({ err: String(error), threadId: this.threadId }, 'thread log write failed');
      }
    });
  }

  flush(): Promise<void> {
    return this.tail;
  }
}

function withRunInput(event: BaseEvent, input: RunAgentInput): BaseEvent {
  // The run's input (with the user's new message) is what a replay rebuilds the conversation from.
  if (event.type !== EventType.RUN_STARTED || 'input' in event) return event;
  return { ...event, input } as BaseEvent;
}

/** A run left open by a process that died gets its closing events before the next run starts. */
async function closeDanglingRun(log: ThreadLog, threadId: string): Promise<void> {
  const state = new RunState();
  for (const { event } of await log.readAfter(threadId, 0)) state.observe(event);
  for (const event of state.closingEvents()) await log.append(threadId, event);
}

async function execute(request: AgentRunnerRunRequest, run: ActiveRun, emit: (event: BaseEvent) => void) {
  const events: BaseEvent[] = [];
  const record = (event: BaseEvent) => {
    events.push(event);
    emit(event);
  };
  let failed = false;
  try {
    await request.agent.runAgent(request.input, { onEvent: ({ event }) => record(withRunInput(event, request.input)) });
  } catch {
    failed = true;
  }
  const closing = finalizeRunEvents([...events], {
    stopRequested: run.stopRequested,
    ...(request.input.protocolVersion ? { protocolVersion: request.input.protocolVersion } : {}),
    ...(failed ? { interruptionMessage: AGENT_FAILED_MESSAGE } : {}),
  });
  for (const event of closing) record(event);
}

async function recordInto(deps: RecorderDeps, request: AgentRunnerRunRequest, subject: ReplaySubject<BaseEvent>) {
  const { threadId } = request;
  const { runId } = request.input;
  if (!(await deps.log.claim(threadId, ɵresolveThreadOwner(request.ownerId)))) throw new ThreadAccessDeniedError();
  if (!(await deps.log.acquireRun(threadId, runId))) throw new ThreadAlreadyRunningError();
  const renew = setInterval(() => {
    deps.log.renewRun(threadId, runId).catch((error) => deps.logger.warn({ err: String(error) }, 'lease renew failed'));
  }, deps.leaseRenewMs);
  const run: ActiveRun = { runId, agent: request.agent, stopRequested: false };
  deps.active.set(threadId, run);
  try {
    await closeDanglingRun(deps.log, threadId);
    const writer = new OrderedWriter(deps, threadId);
    await execute(request, run, (event) => {
      subject.next(event);
      writer.write(event);
    });
    await writer.flush();
  } finally {
    clearInterval(renew);
    if (deps.active.get(threadId) === run) deps.active.delete(threadId);
    await deps.log.releaseRun(threadId, runId);
  }
}

/**
 * Runs the agent and logs every event. The run belongs to this process, not to the HTTP request that
 * started it: a client that disconnects stops reading, and the run goes on to the end of the log.
 */
export function recordRun(deps: RecorderDeps, request: AgentRunnerRunRequest): Observable<BaseEvent> {
  const subject = new ReplaySubject<BaseEvent>();
  recordInto(deps, request, subject).then(
    () => subject.complete(),
    (error: unknown) => subject.error(error),
  );
  return subject.asObservable();
}
