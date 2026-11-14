import type { TransferConfirmData } from '@poc/contracts';
import { useAgent } from '@copilotkit/react-core/v2';
import { useApproval } from './approval-context';
import { confirmCardState, type ConfirmCardState } from './lib/confirm-card-state';
import { hasReceipt } from './lib/find-confirm-card';
import type { OnDecide } from './lib/approval-decision';

export interface ConfirmCard {
  state: ConfirmCardState;
  /** Answers the interrupt; set only while the card is `pending`. */
  decide: OnDecide | null;
}

/** Where a confirm card in the thread stands: awaiting the customer, or settled one way or another. */
export function useConfirmCard(draft: TransferConfirmData): ConfirmCard {
  const { agent } = useAgent();
  const { active, resumeFailed } = useApproval();
  const open = active?.draftId === draft.draftId;
  const state = confirmCardState({
    interruptOpen: open,
    running: agent.isRunning,
    receipted: hasReceipt(agent.messages, draft.draftId),
    resumeFailed,
    expiresAt: draft.expiresAt,
    now: Date.now(),
  });
  return { state, decide: open ? active.decide : null };
}
