import { createContext, useContext } from 'react';
import type { OnDecide } from './lib/approval-decision';

/** The open interrupt, as the confirm card needs it: which draft it is for and how to answer it. */
export interface ActiveApproval {
  draftId: string;
  decide: OnDecide;
}

export interface ApprovalContextValue {
  active: ActiveApproval | null;
  resumeFailed: boolean;
}

export const ApprovalContext = createContext<ApprovalContextValue>({ active: null, resumeFailed: false });

export function useApproval(): ApprovalContextValue {
  return useContext(ApprovalContext);
}
