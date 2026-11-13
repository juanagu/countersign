import type { MiddlewareHandler } from 'hono';

const JSON_MEDIA_TYPE = 'application/json';

/**
 * Refuses POSTs that are not JSON. A cross-site form can only send simple content types, so with
 * SameSite=Strict this closes the CSRF route that a lenient body parser would leave open.
 */
export const requireJsonPost: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== 'POST') return next();
  const mediaType = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (mediaType !== JSON_MEDIA_TYPE) return c.json({ error: 'unsupported_media_type' }, 415);
  return next();
};
