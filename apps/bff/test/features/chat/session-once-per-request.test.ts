import { randomUUID } from 'node:crypto';
import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { buildTestApp, loginCookie, testSession } from '../../support/build-app.js';
import { startFakeBot } from '../../support/fake-bot.js';
import { CountingRevocationStore } from '../../support/revocation-doubles.js';

const RUN = '/copilotkit/agent/default/run';
const CONNECT = '/copilotkit/agent/default/connect';

function body(threadId: string = randomUUID()) {
  return JSON.stringify({
    threadId,
    runId: randomUUID(),
    messages: [{ id: randomUUID(), role: 'user', content: 'hola' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
}

const post = (app: Awaited<ReturnType<typeof buildTestApp>>['app'], path: string, cookie: string, payload: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie },
    body: payload,
  });

describe('the session is resolved once per request', () => {
  it.each([
    ['a chat run', RUN, 1],
    // A connect also restores history, which checks the caller's sid itself (the one extra, deliberate lookup).
    ['a connect', CONNECT, 2],
  ])('looks the sid up the expected number of times for %s', async (_, path, lookups) => {
    const bot = await startFakeBot({ delayMs: 1, deltas: ['hola'] });
    const revocations = new CountingRevocationStore();
    const { app } = await buildTestApp(bot.url, { revocations });
    const cookie = await loginCookie(app);

    const res = await post(app, path, cookie, body());
    await res.text();

    expect(res.status).toBe(200);
    expect(revocations.lookups).toBe(lookups);
    bot.server.close();
  });

  it('serves a run whose session was checked at the door even if a logout lands right after the check', async () => {
    const bot = await startFakeBot({ delayMs: 1, deltas: ['hola'] });
    const revocations = new CountingRevocationStore(1);
    const { app } = await buildTestApp(bot.url, { revocations });
    const cookie = await loginCookie(app);

    const res = await post(app, RUN, cookie, body());

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('RUN_FINISHED');
    bot.server.close();
  });

  it('still refuses a logged-out session at the door', async () => {
    const bot = await startFakeBot();
    const revocations = new CountingRevocationStore();
    const { app } = await buildTestApp(bot.url, { revocations });
    const cookie = await loginCookie(app);
    await revocations.revoke(String(decodeJwt(cookie.replace('session=', '')).sid), 60);
    expect((await post(app, RUN, cookie, body())).status).toBe(401);
    expect(bot.runs).toBe(0);
    bot.server.close();
  });
});

describe('history restore through the app', () => {
  const HISTORY = {
    'ana:t-1': [{ id: 'm-ana', role: 'assistant', content: 'solo de ana' }],
    'juan:t-1': [{ id: 'm-juan', role: 'assistant', content: 'solo de juan' }],
  };

  it.each(['Authorization', 'authorization'])(
    "restores from the session's own identity when the client sends another user's bot token in %s",
    async (headerName) => {
      const bot = await startFakeBot({ delayMs: 1, deltas: ['hola'], history: HISTORY });
      const { app, issuer } = await buildTestApp(bot.url);
      const cookie = await loginCookie(app, 'ana');
      const juansToken = await issuer.issueBotToken(testSession('juan'));

      const res = await app.request(CONNECT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          cookie,
          [headerName]: `Bearer ${juansToken}`,
        },
        body: body('t-1'),
      });
      const text = await res.text();

      expect(res.status).toBe(200);
      expect(text).not.toContain('solo de juan');
      expect(bot.historyCallers).not.toContain('juan');
      expect(bot.historyCallers.every((sub) => sub === 'ana')).toBe(true);
      expect(text).toContain('solo de ana');
      bot.server.close();
    },
  );
});
