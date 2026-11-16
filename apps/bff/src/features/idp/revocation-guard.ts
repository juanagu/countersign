import type { Logger } from 'pino';
import type { RevocationStore } from './revocation-store.js';

/** Which caller of the store a failure came from, so the log says where the outage was felt. */
export type RevocationCheck = 'session' | 'exchange' | 'logout' | 'login';

/**
 * The one place a store failure becomes a refusal: runs `operation`, and when the store cannot answer logs a
 * structured line (never the `sid`, even if the driver put the key in its message) and returns `refused`.
 */
async function failClosed<T>(
  logger: Logger,
  check: RevocationCheck,
  sid: string,
  operation: () => Promise<T>,
  refused: T,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(
      { event: 'revocation_store_unavailable', check, err: message.replaceAll(sid, '[sid]') },
      `${check} refused: revocation store unavailable`,
    );
    return refused;
  }
}

/** True for a logged-out session and, failing closed, for a store that cannot say. */
export function isRevokedOrUnknown(
  store: RevocationStore,
  logger: Logger,
  check: RevocationCheck,
  sid: string,
): Promise<boolean> {
  return failClosed(logger, check, sid, () => store.isRevoked(sid), true);
}

/** True once the revocation is recorded; false when the store could not take it. */
export function recordRevocation(
  store: RevocationStore,
  logger: Logger,
  check: RevocationCheck,
  sid: string,
  ttlSeconds: number,
): Promise<boolean> {
  return failClosed(logger, check, sid, () => store.revoke(sid, ttlSeconds).then(() => true), false);
}
