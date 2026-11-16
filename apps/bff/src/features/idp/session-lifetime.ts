/** How long a session lasts without activity; every re-issue pushes the expiry this far out. */
export const SESSION_IDLE_TTL_SECONDS = 30 * 60;
/** How long after login a session ends whatever its activity. */
export const SESSION_ABSOLUTE_TTL_SECONDS = 8 * 60 * 60;
/** A request re-issues the cookie once less than this is left of its lifetime. */
export const SESSION_SLIDE_BELOW_SECONDS = SESSION_IDLE_TTL_SECONDS / 2;
/** The longest a token minted from a session outlives it: the `aud=bot` token's lifetime. */
export const DOWNSTREAM_TOKEN_TAIL_SECONDS = 5 * 60;

export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

/** The expiry a session issued (or re-issued) at `now` gets: idle lifetime, never past the absolute cap. */
export function sessionExpiry(authTime: number, now: number): number {
  return Math.min(now + SESSION_IDLE_TTL_SECONDS, authTime + SESSION_ABSOLUTE_TTL_SECONDS);
}

export function isPastAbsoluteCap(authTime: number, now: number): boolean {
  return now >= authTime + SESSION_ABSOLUTE_TTL_SECONDS;
}

/** True when the session is in the second half of its life and a re-issue would actually extend it. */
export function shouldSlide(session: { exp: number; authTime: number }, now: number): boolean {
  return session.exp - now < SESSION_SLIDE_BELOW_SECONDS && sessionExpiry(session.authTime, now) > session.exp;
}

/**
 * How long a revoked `sid` must stay on the denylist: until the session could no longer be valid, plus the
 * tail in which a token already minted from it could still be presented for exchange.
 */
export function revocationTtlSeconds(authTime: number, now: number): number {
  return Math.max(1, authTime + SESSION_ABSOLUTE_TTL_SECONDS + DOWNSTREAM_TOKEN_TAIL_SECONDS - now);
}
