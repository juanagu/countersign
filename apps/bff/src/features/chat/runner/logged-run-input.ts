import { isDeepStrictEqual } from 'node:util';
import type { Message, RunAgentInput } from '@ag-ui/client';

type ResumeEntry = NonNullable<RunAgentInput['resume']>[number];

/** Keys that hold the approval's step-up token: the bot needs it once, the log and its replays never. */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set(['editedArgs', 'step_up_token']);

/** The value with every credential key removed, at any depth. */
function withoutCredentials(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutCredentials);
  if (value === null || typeof value !== 'object') return value;
  const kept = Object.entries(value).filter(([key]) => !CREDENTIAL_KEYS.has(key));
  return Object.fromEntries(kept.map(([key, nested]) => [key, withoutCredentials(nested)]));
}

function carriesCredential(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(carriesCredential);
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, nested]) => CREDENTIAL_KEYS.has(key) || carriesCredential(nested));
}

function parsedContent(content: unknown): unknown {
  if (typeof content !== 'string') return content;
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
}

/** What CopilotKit's `useInterrupt.resolve` writes as the tool message answering the entry's interrupt. */
function answerFor(entry: ResumeEntry): unknown {
  if (entry.status === 'cancelled') return { status: 'cancelled' };
  return 'payload' in entry && entry.payload !== undefined ? entry.payload : { status: 'resolved' };
}

/** A tool message whose content is one of this run's resume answers, or that carries a credential at all. */
function isInterruptAnswer(message: Message, answers: readonly unknown[]): boolean {
  if (message.role !== 'tool') return false;
  const content = parsedContent(message.content);
  return carriesCredential(content) || answers.some((answer) => isDeepStrictEqual(answer, content));
}

/**
 * The run input as RUN_STARTED carries it into the thread log. Messages stay, so a replay rebuilds the user's turns
 * from them, minus the tool message CopilotKit adds before resuming an interrupt: its content is the resume payload,
 * step-up token included. The resume entry still holds the answer (`approved`, `reason`), without the token.
 */
export function loggableRunInput(input: RunAgentInput): RunAgentInput {
  const answers = (input.resume ?? []).map(answerFor);
  const messages = input.messages.filter((message) => !isInterruptAnswer(message, answers));
  return withoutCredentials({ ...input, messages }) as RunAgentInput;
}
