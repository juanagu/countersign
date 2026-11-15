import { useAgent, useCopilotKit, useInterrupt } from '@copilotkit/react-core/v2';
import { useEffect, useMemo, useState, type Dispatch, type ReactNode, type SetStateAction } from 'react';
import { ApprovalContext, type ActiveApproval } from './approval-context';
import { MissingDraftCard } from './missing-draft-card';
import { findConfirmCard } from './lib/find-confirm-card';
import { withoutStepUpAnswers } from './lib/interrupt-answer';
import { showsResumeFailed } from './lib/resume-outcome';
import type { OnDecide } from './lib/approval-decision';

export interface TransferApprovalProps {
  /** Whether the last approval's resume failed: the card is gone from the interrupt by then, so the chat holds it. */
  resumeFailed: boolean;
  setResumeFailed: Dispatch<SetStateAction<boolean>>;
  /** The chat: the confirm card inside it reads the approval through `useApproval`. */
  children: ReactNode;
}

interface PublishProps {
  draftId: string | undefined;
  decide: OnDecide;
  publish: (active: ActiveApproval | null) => void;
}

/**
 * Hands the open interrupt to the confirm card in the thread (it renders nothing itself). When the thread has no
 * card for the draft, the only way out is to discard, so that fallback goes into CopilotKit's interrupt slot.
 */
function PublishApproval({ draftId, decide, publish }: PublishProps) {
  const { agent } = useAgent();
  const { copilotkit } = useCopilotKit();
  const cardFound = draftId !== undefined && findConfirmCard(agent.messages, draftId) !== undefined;

  useEffect(() => {
    if (!draftId || !cardFound) return;
    publish({ draftId, decide });
    return () => publish(null);
  }, [draftId, cardFound, decide, publish]);

  useEffect(() => {
    if (cardFound) return;
    copilotkit.setInterruptElement(<MissingDraftCard onDecide={decide} />);
    return () => copilotkit.setInterruptElement(null);
  }, [cardFound, copilotkit, decide]);

  return null;
}

/** Watches the bot's `execute_transfer` pause and gives the confirm card what it needs to approve or decline it. */
export function TransferApproval({ resumeFailed, setResumeFailed, children }: TransferApprovalProps) {
  const { agent } = useAgent({ updates: [] });
  const [active, setActive] = useState<ActiveApproval | null>(null);

  useEffect(() => {
    // CopilotKit's runAgent swallows a failed run, so `resolve` never rejects for it: only the agent's events tell.
    const subscription = agent.subscribe({
      onRunStartedEvent: ({ input }) => setResumeFailed((shown) => showsResumeFailed(shown, 'started', input)),
      onRunErrorEvent: ({ input }) => setResumeFailed((shown) => showsResumeFailed(shown, 'failed', input)),
      onRunFailed: ({ input }) => setResumeFailed((shown) => showsResumeFailed(shown, 'failed', input)),
    });
    return () => subscription.unsubscribe();
  }, [agent, setResumeFailed]);

  const publisher = useInterrupt({
    renderInChat: false,
    render: ({ interrupt, resolve }) => {
      const draftId = (interrupt?.metadata as { draft_id?: unknown } | undefined)?.draft_id;
      const decide: OnDecide = async (decision) => {
        try {
          await resolve(decision, interrupt?.id);
        } catch {
          if (decision.approved) setResumeFailed(true); // CopilotKit refused the answer before running.
        } finally {
          // The bot ignores this answer too; dropping it keeps the spent token off every later request.
          agent.setMessages(withoutStepUpAnswers(agent.messages));
        }
      };
      return (
        <PublishApproval
          draftId={typeof draftId === 'string' ? draftId : undefined}
          decide={decide}
          publish={setActive}
        />
      );
    },
  });

  const value = useMemo(() => ({ active, resumeFailed }), [active, resumeFailed]);
  return (
    <ApprovalContext.Provider value={value}>
      {publisher}
      {children}
    </ApprovalContext.Provider>
  );
}
