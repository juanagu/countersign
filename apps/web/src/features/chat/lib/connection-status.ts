import { useSyncExternalStore } from 'react';
import type { ReconnectState } from './reconnector';

let current: ReconnectState = 'idle';
const listeners = new Set<() => void>();

/** The reconnector's state, shared with the pill above the composer: one chat per page, so one store. */
export function setConnectionStatus(next: ReconnectState): void {
  if (next === current) return;
  current = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useConnectionStatus(): ReconnectState {
  return useSyncExternalStore(subscribe, () => current);
}
