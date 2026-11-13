interface MessageLike {
  role: string;
  content?: unknown;
}

function carriesStepUpToken(content: unknown): boolean {
  if (typeof content !== 'string') return false;
  try {
    const payload: unknown = JSON.parse(content);
    const edited = (payload as { editedArgs?: { step_up_token?: unknown } } | null)?.editedArgs;
    return typeof edited?.step_up_token === 'string';
  } catch {
    return false;
  }
}

/**
 * The history without the tool message CopilotKit's `resolve` adds for an approval: its content is the resume
 * payload, step-up token included, and CopilotKit would send it with every later turn.
 */
export function withoutStepUpAnswers<M extends MessageLike>(messages: readonly M[]): M[] {
  return messages.filter((message) => message.role !== 'tool' || !carriesStepUpToken(message.content));
}
