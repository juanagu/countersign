import type { BankTemplate, TransferConfirmData } from '@poc/contracts';

interface MessageLike {
  role: string;
  activityType?: string;
  content?: unknown;
}

/**
 * The confirm card the bot rendered for this draft, from the server template in the thread.
 * The approval panel shows these figures, never the interrupt's (model-proposed) arguments.
 */
export function findConfirmCard(messages: readonly MessageLike[], draftId: string): TransferConfirmData | undefined {
  for (const message of messages) {
    if (message.role !== 'activity' || message.activityType !== 'bank-template') continue;
    const template = message.content as BankTemplate | undefined;
    if (template?.template === 'transfer-confirm' && template.data.draftId === draftId) return template.data;
  }
  return undefined;
}

/** Whether the thread holds the receipt the bot rendered once this draft was executed. */
export function hasReceipt(messages: readonly MessageLike[], draftId: string): boolean {
  return messages.some((message) => {
    if (message.role !== 'activity' || message.activityType !== 'bank-template') return false;
    const template = message.content as BankTemplate | undefined;
    return template?.template === 'transfer-receipt' && template.data.draftId === draftId;
  });
}
