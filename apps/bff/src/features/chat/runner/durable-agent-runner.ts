import type { BaseEvent } from '@ag-ui/client';
import {
  AgentRunner,
  ɵresolveThreadOwner,
  type AgentRunnerConnectRequest,
  type AgentRunnerIsRunningRequest,
  type AgentRunnerRunRequest,
  type AgentRunnerStopRequest,
  type LocalThreadEndpointScope,
} from '@copilotkit/runtime/v2';
import type { Logger } from 'pino';
import type { Observable } from 'rxjs';
import { recordRun, type ActiveRun } from './run-recorder.js';
import type { ThreadHistory } from './thread-history.js';
import type { ThreadLog } from './thread-log.js';
import { replayThread } from './thread-replay.js';

export interface DurableAgentRunnerOptions {
  log: ThreadLog;
  history: ThreadHistory;
  logger: Logger;
  leaseRenewMs?: number;
  followWaitMs?: number;
}

const DEFAULT_LEASE_RENEW_MS = 5_000;
const DEFAULT_FOLLOW_WAIT_MS = 5_000;

/**
 * CopilotKit runner whose threads live in a `ThreadLog` (Redis) instead of process memory: runs outlive
 * their client, `connect` replays and follows a thread, and every call honours the thread's owner.
 */
export class DurableAgentRunner extends AgentRunner {
  private readonly active = new Map<string, ActiveRun>();
  private readonly log: ThreadLog;

  constructor(private readonly options: DurableAgentRunnerOptions) {
    super();
    this.log = options.log;
  }

  override async isThreadAccessible(threadId: string, scope: LocalThreadEndpointScope): Promise<boolean> {
    const owner = await this.log.ownerOf(threadId);
    return owner === null || owner === scope.ownerId;
  }

  run(request: AgentRunnerRunRequest): Observable<BaseEvent> {
    const { log, logger, leaseRenewMs = DEFAULT_LEASE_RENEW_MS } = this.options;
    return recordRun({ log, logger, active: this.active, leaseRenewMs }, request);
  }

  connect(request: AgentRunnerConnectRequest): Observable<BaseEvent> {
    const { log, history, followWaitMs = DEFAULT_FOLLOW_WAIT_MS } = this.options;
    return replayThread(
      { log, history, followWaitMs },
      request.threadId,
      ɵresolveThreadOwner(request.ownerId),
      request.headers ?? {},
    );
  }

  async isRunning(request: AgentRunnerIsRunningRequest): Promise<boolean> {
    if (!(await this.owns(request.threadId, request.ownerId))) return false;
    return (await this.log.activeRun(request.threadId)) !== null;
  }

  async stop(request: AgentRunnerStopRequest): Promise<boolean> {
    const run = this.active.get(request.threadId);
    if (!run || run.stopRequested) return false;
    if (request.runId !== undefined && request.runId !== run.runId) return false;
    if (!(await this.owns(request.threadId, request.ownerId))) return false;
    run.stopRequested = true;
    run.agent.abortRun();
    return true;
  }

  private async owns(threadId: string, ownerId: string | undefined): Promise<boolean> {
    return (await this.log.ownerOf(threadId)) === ɵresolveThreadOwner(ownerId);
  }
}
