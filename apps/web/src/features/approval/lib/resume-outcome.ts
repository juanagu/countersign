export const RESUME_FAILED_NOTICE = 'No pudimos confirmar la transferencia. Pedime de nuevo que la envíe.';

interface ResumeEntryLike {
  status?: string;
  payload?: unknown;
}

export interface RunInputLike {
  resume?: readonly ResumeEntryLike[];
}

export type RunSignal = 'started' | 'failed';

function approvesTransfer(input: RunInputLike | undefined): boolean {
  return (input?.resume ?? []).some(
    (entry) => entry.status === 'resolved' && (entry.payload as { approved?: unknown } | null)?.approved === true,
  );
}

/**
 * Whether the chat shows the failed-confirmation notice after a run signal. `useInterrupt` unmounts the panel as
 * the resume starts and can't resume again after it fails, so the way forward is asking the bot again: that
 * prepares a new interrupt and a new step-up. Any run start clears it; a failed cancel moves no money, so it
 * says nothing.
 */
export function showsResumeFailed(shown: boolean, signal: RunSignal, input: RunInputLike | undefined): boolean {
  if (signal === 'started') return false;
  return shown || approvesTransfer(input);
}
