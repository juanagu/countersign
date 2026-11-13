import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, loginCookie, TEST_ISSUER } from '../../support/build-app.js';

const RUN_PATH = '/copilotkit/agent/default/run';

/** A stand-in bot that records request headers and streams a fixed AG-UI run. */
async function startFakeBot(): Promise<{ url: string; requests: IncomingHttpHeaders[]; server: Server }> {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hola' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
        { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' },
      ];
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/agent`, requests, server };
}

function runBody() {
  return JSON.stringify({
    threadId: 't1',
    runId: 'r1',
    messages: [{ id: 'u1', role: 'user', content: 'hola' }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
}

describe('chat endpoint', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it('rejects a run without a session and never reaches the bot', async () => {
    const bot = await startFakeBot();
    server = bot.server;
    const { app } = await buildTestApp(bot.url);
    const res = await app.request(RUN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: runBody(),
    });
    expect(res.status).toBe(401);
    expect(bot.requests).toHaveLength(0);
  });

  it('forwards a per-user aud=bot token, never the session cookie', async () => {
    const bot = await startFakeBot();
    server = bot.server;
    const { app } = await buildTestApp(bot.url);
    const cookie = await loginCookie(app, 'ana');

    const res = await app.request(RUN_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie },
      body: runBody(),
    });
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain('Hola');
    expect(bot.requests).toHaveLength(1);
    const headers = bot.requests[0] ?? {};
    expect(headers.cookie).toBeUndefined();
    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    expect(token).not.toBe(cookie.replace('session=', ''));
    const jwks = createLocalJWKSet(await (await app.request('/.well-known/jwks.json')).json());
    const { payload } = await jwtVerify(token, jwks, { issuer: TEST_ISSUER, audience: 'bot' });
    expect(payload.sub).toBe('ana');
    expect((payload.exp ?? Infinity) - (payload.iat ?? 0)).toBeLessThanOrEqual(300);
  });
});
