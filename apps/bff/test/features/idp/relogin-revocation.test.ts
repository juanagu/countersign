import { describe, expect, it } from 'vitest';
import { buildTestApp, loginCookie } from '../../support/build-app.js';
import {
  capturingLogger,
  RecordingRevocationStore,
  SwitchableRevocationStore,
} from '../../support/revocation-doubles.js';

const login = (app: Awaited<ReturnType<typeof buildTestApp>>['app'], cookie?: string, username = 'ana') =>
  app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
    body: JSON.stringify({ username }),
  });
const me = (app: Awaited<ReturnType<typeof buildTestApp>>['app'], cookie: string) =>
  app.request('/auth/me', { headers: { cookie } });

describe('a login while holding a session', () => {
  it('revokes the previous sid before issuing the new session', async () => {
    const revocations = new RecordingRevocationStore();
    const { app } = await buildTestApp(undefined, { revocations });
    const first = await loginCookie(app);

    const res = await login(app, first);
    const second = res.headers.get('set-cookie')?.split(';')[0] ?? '';

    expect(res.status).toBe(200);
    expect(revocations.calls).toHaveLength(1);
    expect((await me(app, first)).status).toBe(401);
    expect((await me(app, second)).status).toBe(200);
  });

  it('revokes the previous session even when it signs in as someone else', async () => {
    const { app } = await buildTestApp();
    const ana = await loginCookie(app, 'ana');
    await login(app, ana, 'juan');
    expect((await me(app, ana)).status).toBe(401);
  });

  it('records nothing for a login with no cookie, an unverifiable one, or an unknown user', async () => {
    const revocations = new RecordingRevocationStore();
    const { app } = await buildTestApp(undefined, { revocations });
    const live = await loginCookie(app);
    await login(app);
    await login(app, 'session=not-a-jwt');
    expect((await login(app, live, 'nobody')).status).toBe(401);
    expect(revocations.calls).toEqual([]);
    expect((await me(app, live)).status).toBe(200);
  });

  it('answers 503 and issues no cookie when the old session cannot be revoked, leaving the old one in place', async () => {
    const revocations = new SwitchableRevocationStore();
    const { logger, lines } = capturingLogger();
    const { app } = await buildTestApp(undefined, { revocations, logger });
    const first = await loginCookie(app);
    revocations.down = true;

    const res = await login(app, first);

    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
    revocations.down = false;
    expect((await me(app, first)).status).toBe(200);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ event: 'revocation_store_unavailable', check: 'login' });
  });

  it('still signs in with no previous session while the store is down', async () => {
    const revocations = new SwitchableRevocationStore();
    revocations.down = true;
    const { app } = await buildTestApp(undefined, { revocations });
    expect((await login(app)).status).toBe(200);
  });
});
