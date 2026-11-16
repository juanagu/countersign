import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchSession, login, logout } from '../../../src/features/auth/lib/auth-api';

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

  it('rejects, instead of reporting no session, when the BFF cannot check it (503): only a 401 signs out', async () => {
    stubFetch(503, { error: 'session_check_unavailable' });
    await expect(fetchSession()).rejects.toThrow('503');
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

  it('logs out with a JSON POST, which the BFF requires', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(logout()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/auth/logout',
      expect.objectContaining({ method: 'POST', headers: { 'content-type': 'application/json' } }),
    );
  });

  it('rejects when the BFF does not confirm the logout', async () => {
    stubFetch(500, { error: 'boom' });
    await expect(logout()).rejects.toThrow('logout failed: 500');
  });

  it('rejects when the BFF cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(logout()).rejects.toThrow();
  });
});
