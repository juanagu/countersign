import { useAgent, useInterrupt } from '@copilotkit/react-core/v2';
import { useEffect, type Dispatch, type SetStateAction } from 'react';
import { ApprovalPanel } from './approval-panel';
import { findConfirmCard } from './lib/find-confirm-card';
import { withoutStepUpAnswers } from './lib/interrupt-answer';
import { showsResumeFailed } from './lib/resume-outcome';

export interface TransferApprovalProps {
  /** The chat-level "we couldn't confirm" notice: the panel is gone by the time a resume fails. */
  setResumeFailed: Dispatch<SetStateAction<boolean>>;
}

/** Renders the approval step in the chat when the bot pauses `execute_transfer` for the customer. */
export function TransferApproval({ setResumeFailed }: TransferApprovalProps) {
  const { agent } = useAgent();

  useEffect(() => {
    // CopilotKit's runAgent swallows a failed run, so `resolve` never rejects for it: only the agent's events tell.
    const subscription = agent.subscribe({
      onRunStartedEvent: ({ input }) => setResumeFailed((shown) => showsResumeFailed(shown, 'started', input)),
      onRunErrorEvent: ({ input }) => setResumeFailed((shown) => showsResumeFailed(shown, 'failed', input)),
      onRunFailed: ({ input }) => setResumeFailed((shown) => showsResumeFailed(shown, 'failed', input)),
    });
    return () => subscription.unsubscribe();
  }, [agent, setResumeFailed]);

  useInterrupt({
    render: ({ interrupt, resolve }) => {
      const draftId = (interrupt?.metadata as { draft_id?: unknown } | undefined)?.draft_id;
      const draft = typeof draftId === 'string' ? findConfirmCard(agent.messages, draftId) : undefined;
      return (
        <ApprovalPanel
          draft={draft}
          onDecide={async (decision) => {
            try {
              await resolve(decision, interrupt?.id);
            } catch {
              if (decision.approved) setResumeFailed(true); // CopilotKit refused the answer before running.
            } finally {
              // The bot ignores this answer too; dropping it keeps the spent token off every later request.
              agent.setMessages(withoutStepUpAnswers(agent.messages));
            }
          }}
        />
      );
    },
  });
  return null;
}
