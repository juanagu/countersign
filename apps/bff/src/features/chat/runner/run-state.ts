import { EventType, type BaseEvent } from '@ag-ui/client';
import { createRunEventFinalizer, type RunEventFinalizer } from '@copilotkit/runtime/v2';

/** RUN_ERROR text for a run whose process died before it finished. No internals reach the client. */
export const LOST_RUN_MESSAGE = 'La respuesta se interrumpió antes de terminar.';

export function isTerminal(event: BaseEvent): boolean {
  return event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;
}

/** Follows the runs in a thread's events: whether the last one is still open, and what would close it. */
export class RunState {
  private finalizer: RunEventFinalizer = createRunEventFinalizer();
  private open = false;

  get isOpen(): boolean {
    return this.open;
  }

  observe(event: BaseEvent): void {
    if (event.type === EventType.RUN_STARTED) {
      this.finalizer = createRunEventFinalizer();
      this.open = true;
    }
    this.finalizer.observe(event);
    if (isTerminal(event)) this.open = false;
  }

  /** Ends the open run as interrupted: closes its open messages and tool calls, then a RUN_ERROR. */
  closingEvents(): BaseEvent[] {
    if (!this.open) return [];
    this.open = false;
    return this.finalizer.finalize({ interruptionMessage: LOST_RUN_MESSAGE });
  }
}
