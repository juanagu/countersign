import { z } from 'zod';

const API_BASE = '/api';

const sessionUserSchema = z.object({ id: z.string(), name: z.string() });
const demoUsersSchema = z.array(sessionUserSchema);

export type SessionUser = z.infer<typeof sessionUserSchema>;

async function expectOk(res: Response): Promise<unknown> {
  if (!res.ok) throw new Error(`request failed: ${res.status}`);
  return res.json();
}

/** The signed-in user, or null when there is no valid session. */
export async function fetchSession(): Promise<SessionUser | null> {
  const res = await fetch(`${API_BASE}/auth/me`);
  if (res.status === 401) return null;
  return sessionUserSchema.parse(await expectOk(res));
}

export async function fetchDemoUsers(): Promise<SessionUser[]> {
  return demoUsersSchema.parse(await expectOk(await fetch(`${API_BASE}/auth/demo-users`)));
}

export async function login(username: string): Promise<SessionUser> {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  return sessionUserSchema.parse(await expectOk(res));
}

/** Ends the session; rejects when the BFF could not be reached or did not clear the cookie. */
export async function logout(): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (!res.ok) throw new Error(`logout failed: ${res.status}`);
}
