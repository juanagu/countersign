/** Each signed-in user's current thread id, kept across reloads so the BFF can restore the conversation. */

const KEY_PREFIX = 'chat.thread.';

export type ThreadIdStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function browserStorage(): ThreadIdStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null; // Blocked storage (private mode, policy): the thread then lasts until the next reload.
  }
}

/** The user's thread id, minting and saving one the first time. */
export function threadIdFor(
  userId: string,
  storage: ThreadIdStorage | null = browserStorage(),
  newId: () => string = () => crypto.randomUUID(),
): string {
  const key = KEY_PREFIX + userId;
  try {
    const saved = storage?.getItem(key);
    if (saved) return saved;
    const id = newId();
    storage?.setItem(key, id);
    return id;
  } catch {
    return newId();
  }
}

/** Sign-out starts a fresh thread next time. */
export function forgetThread(userId: string, storage: ThreadIdStorage | null = browserStorage()): void {
  try {
    storage?.removeItem(KEY_PREFIX + userId);
  } catch {
    // Nothing to forget if storage is unavailable.
  }
}

/** "Nueva conversación": drops the saved thread and saves a fresh id for the next reload to restore. */
export function startNewThread(
  userId: string,
  storage: ThreadIdStorage | null = browserStorage(),
  newId: () => string = () => crypto.randomUUID(),
): string {
  forgetThread(userId, storage);
  return threadIdFor(userId, storage, newId);
}
