import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_IDLE_TTL_SECONDS } from '../../../src/features/idp/session-lifetime.js';
import { buildTestApp, loginCookie } from '../../support/build-app.js';
import { startFakeBot } from '../../support/fake-bot.js';

const RUN = '/copilotkit/agent/default/run';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-03-02T09:00:00Z'));
});
afterEach(() => vi.useRealTimers());

function runInit(cookie: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie },
    body: JSON.stringify({
      threadId: randomUUID(),
      runId: randomUUID(),
      messages: [{ id: randomUUID(), role: 'user', content: 'hola' }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    }),
  };
}

describe('sliding session on a streamed chat run', () => {
  it('sets the re-issued cookie on the response headers, ahead of the stream, with the same sid and auth_time', async () => {
    const bot = await startFakeBot({ delayMs: 5, deltas: ['uno', 'dos'] });
    const { app } = await buildTestApp(bot.url);
    const cookie = await loginCookie(app);
    const before = decodeJwt(cookie.replace('session=', ''));
    vi.setSystemTime(new Date(Date.now() + 20 * 60_000));

    const res = await app.request(RUN, runInit(cookie));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const refreshed = decodeJwt((res.headers.get('set-cookie') ?? '').split(';')[0]?.replace('session=', '') ?? '');
    expect(refreshed.sid).toBe(before.sid);
    expect(refreshed.auth_time).toBe(before.auth_time);
    expect(refreshed.exp).toBe(Math.floor(Date.now() / 1000) + SESSION_IDLE_TTL_SECONDS);
    expect(await res.text()).toContain('RUN_FINISHED');
    bot.server.close();
  });

  it('sets no cookie on a run early in the session', async () => {
    const bot = await startFakeBot({ delayMs: 5, deltas: ['uno'] });
    const { app } = await buildTestApp(bot.url);
    const res = await app.request(RUN, runInit(await loginCookie(app)));
    expect(res.headers.get('set-cookie')).toBeNull();
    await res.text();
    bot.server.close();
  });
});
