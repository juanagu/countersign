import { describe, expect, it } from 'vitest';
import { isRevokedOrUnknown, recordRevocation } from '../../../src/features/idp/revocation-guard.js';
import { capturingLogger, UnavailableRevocationStore } from '../../support/revocation-doubles.js';
import { MemoryRevocationStore } from '../../support/memory-revocation-store.js';

const SID = 'sid-secret-value';

describe('the fail-closed helpers', () => {
  it('answer from the store when it works', async () => {
    const { logger, lines } = capturingLogger();
    const store = new MemoryRevocationStore();
    expect(await isRevokedOrUnknown(store, logger, 'session', SID)).toBe(false);
    expect(await recordRevocation(store, logger, 'logout', SID, 60)).toBe(true);
    expect(await isRevokedOrUnknown(store, logger, 'session', SID)).toBe(true);
    expect(lines).toEqual([]);
  });

  it.each(['session', 'exchange', 'logout', 'login'] as const)(
    'refuse and log one structured line for %s, without the sid even when the driver put it in its message',
    async (check) => {
      const { logger, lines } = capturingLogger();
      const store = {
        ...new UnavailableRevocationStore(),
        isRevoked: async () => Promise.reject(new Error(`timeout on auth:revoked:${SID}`)),
        revoke: async () => Promise.reject(new Error(`timeout on auth:revoked:${SID}`)),
      };

      expect(await isRevokedOrUnknown(store, logger, check, SID)).toBe(true);
      expect(await recordRevocation(store, logger, check, SID, 60)).toBe(false);

      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(JSON.parse(line)).toMatchObject({ event: 'revocation_store_unavailable', check, level: 50 });
        expect(line).not.toContain(SID);
      }
    },
  );
});
