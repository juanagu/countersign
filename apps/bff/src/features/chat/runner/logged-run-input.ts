import type { RunAgentInput } from '@ag-ui/client';

type ResumeEntry = NonNullable<RunAgentInput['resume']>[number];

/** `editedArgs` carries the approval's step-up token: the bot needs it once, the log and its replays never. */
const CREDENTIAL_FIELDS: readonly string[] = ['editedArgs'];

function withoutCredentials(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  return Object.fromEntries(Object.entries(payload).filter(([key]) => !CREDENTIAL_FIELDS.includes(key)));
}

function loggableEntry(entry: ResumeEntry): ResumeEntry {
  if (!('payload' in entry)) return entry;
  return { ...entry, payload: withoutCredentials(entry.payload) };
}

/**
 * The run input as RUN_STARTED carries it into the thread log. Messages stay: a replay rebuilds the user's turns
 * from them. A resume keeps its answer (`approved`, `reason`) and loses what only the bot may hold.
 */
export function loggableRunInput(input: RunAgentInput): RunAgentInput {
  if (!Array.isArray(input.resume)) return input;
  return { ...input, resume: input.resume.map(loggableEntry) };
}
