import { useAgent, useInterrupt } from '@copilotkit/react-core/v2';
import { ApprovalPanel } from './approval-panel';
import { findConfirmCard } from './lib/find-confirm-card';
import { withoutStepUpAnswers } from './lib/interrupt-answer';

/** Renders the approval step in the chat when the bot pauses `execute_transfer` for the customer. */
export function TransferApproval() {
  const { agent } = useAgent();
  useInterrupt({
    render: ({ interrupt, resolve }) => {
      const draftId = (interrupt?.metadata as { draft_id?: unknown } | undefined)?.draft_id;
      const draft = typeof draftId === 'string' ? findConfirmCard(agent.messages, draftId) : undefined;
      return (
        <ApprovalPanel
          draft={draft}
          onDecide={async (decision) => {
            try {
              return await resolve(decision, interrupt?.id);
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
