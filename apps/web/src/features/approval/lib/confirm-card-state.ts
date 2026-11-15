export type ConfirmCardState =
  /** The interrupt is open for this draft: Cancelar and Confirmar are live. */
  | 'pending'
  /** The agent is running (a resume, a replay or a reload): the pending layout, without buttons. */
  | 'waiting'
  | 'confirmed'
  | 'expired'
  | 'not-sent'
  | 'resume-failed';

export type ResolvedState = Exclude<ConfirmCardState, 'pending' | 'waiting'>;

export interface ConfirmCardFacts {
  /** This card's draft has an open interrupt. */
  interruptOpen: boolean;
  running: boolean;
  /** A receipt for this draft is in the thread. */
  receipted: boolean;
  resumeFailed: boolean;
  expiresAt: string;
  now: number;
}

/**
 * What a confirm card shows, from the thread and the agent alone. A receipt wins over everything; while the agent
 * runs the card never claims an outcome, so a replay or a reload doesn't flash "No se envió".
 */
export function confirmCardState(facts: ConfirmCardFacts): ConfirmCardState {
  if (facts.receipted) return 'confirmed';
  if (facts.interruptOpen) return 'pending';
  if (facts.running) return 'waiting';
  if (facts.resumeFailed) return 'resume-failed';
  return facts.now > Date.parse(facts.expiresAt) ? 'expired' : 'not-sent';
}

/** The states where the card has collapsed to one line. */
export function isResolved(state: ConfirmCardState): state is ResolvedState {
  return state !== 'pending' && state !== 'waiting';
}
