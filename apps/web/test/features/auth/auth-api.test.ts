import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSession, login } from '../../../src/features/auth/lib/auth-api';

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('auth-api', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns null when there is no session', async () => {
    stubFetch(401, { error: 'unauthenticated' });
    expect(await fetchSession()).toBeNull();
  });

  it('returns the session user', async () => {
    stubFetch(200, { id: 'ana', name: 'Ana Gómez' });
    expect(await fetchSession()).toEqual({ id: 'ana', name: 'Ana Gómez' });
  });

  it('rejects a malformed session response', async () => {
    stubFetch(200, { id: 42 });
    await expect(fetchSession()).rejects.toThrow();
  });

  it('logs in through the same-origin /api proxy', async () => {
    const fetchMock = stubFetch(200, { id: 'juan', name: 'Juan Pérez' });
    await login('juan');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/login', expect.objectContaining({ method: 'POST' }));
  });

  it('throws when login fails', async () => {
    stubFetch(401, { error: 'unknown_user' });
    await expect(login('mallory')).rejects.toThrow();
  });
});
