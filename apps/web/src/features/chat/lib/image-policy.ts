/**
 * Whether assistant markdown may load this image: only from the app's own origin. A remote image loads with no
 * click, so its URL could carry conversation data off-site; data and blob images are refused too.
 */
export function isSameOriginImage(src: unknown, origin: string | undefined): boolean {
  if (typeof src !== 'string' || !origin) return false;
  try {
    const url = new URL(src, origin);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === origin;
  } catch {
    return false;
  }
}
