import { randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, loginCookie, TEST_ISSUER } from '../../support/build-app.js';

const RUN_PATH = '/copilotkit/agent/default/run';
const CONNECT_PATH = '/copilotkit/agent/default/connect';

/** A stand-in bot that records request headers and streams a fixed AG-UI run. */
async function startFakeBot(): Promise<{ url: string; requests: IncomingHttpHeaders[]; server: Server }> {
  const requests: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    requests.push(req.headers);
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const { threadId = 't1', runId = 'r1' } = JSON.parse(raw || '{}') as { threadId?: string; runId?: string };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'RUN_STARTED', threadId, runId },
        { type: 'TEXT_MESSAGE_START', messageId: `m-${runId}`, role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: `m-${runId}`, delta: 'Hola' },
        { type: 'TEXT_MESSAGE_END', messageId: `m-${runId}` },
        { type: 'RUN_FINISHED', threadId, runId },
      ];
      for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/agent`, requests, server };
}

// The in-memory runner's thread store is process-wide, so every test uses fresh thread ids.
function runBody(threadId = randomUUID()) {
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

function post(path: string, cookie: string, body: string, extra: Record<string, string> = {}) {
  return {
    path,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', cookie, ...extra },
      body,
    },
  };
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

    const { path, init } = post(RUN_PATH, cookie, runBody());
    const res = await app.request(path, init);
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

  it("keeps Ana's thread from Juan: he can neither replay it nor run on it", async () => {
    const bot = await startFakeBot();
    server = bot.server;
    const { app } = await buildTestApp(bot.url);
    const ana = await loginCookie(app, 'ana');
    const juan = await loginCookie(app, 'juan');
    const threadId = randomUUID();

    const anaRun = post(RUN_PATH, ana, runBody(threadId));
    expect(await (await app.request(anaRun.path, anaRun.init)).text()).toContain('Hola');

    // Ana can replay her own thread, which proves the connect below targets a live thread.
    const anaConnect = post(CONNECT_PATH, ana, runBody(threadId));
    expect(await (await app.request(anaConnect.path, anaConnect.init)).text()).toContain('Hola');

    const juanConnect = post(CONNECT_PATH, juan, runBody(threadId));
    const replay = await app.request(juanConnect.path, juanConnect.init);
    expect(await replay.text()).not.toContain('Hola');

    const juanRun = post(RUN_PATH, juan, runBody(threadId));
    const run = await app.request(juanRun.path, juanRun.init);
    expect(run.status).toBe(404);
    expect(bot.requests).toHaveLength(1);
  });

  it('refuses a non-JSON POST with 415 before it reaches the runtime', async () => {
    const bot = await startFakeBot();
    server = bot.server;
    const { app } = await buildTestApp(bot.url);
    const { path, init } = post(RUN_PATH, await loginCookie(app), runBody(), { 'content-type': 'text/plain' });
    expect((await app.request(path, init)).status).toBe(415);
    expect(bot.requests).toHaveLength(0);
  });

  it('sends no CORS headers, not even to a preflight from another origin', async () => {
    const bot = await startFakeBot();
    server = bot.server;
    const { app } = await buildTestApp(bot.url);
    const cookie = await loginCookie(app);
    const origin = 'https://evil.example';

    const { path, init } = post(RUN_PATH, cookie, runBody(), { origin });
    const run = await app.request(path, init);
    await run.text();
    expect(run.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await app.request(RUN_PATH, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', cookie },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  // CopilotKit serves its cross-thread event feed whenever NODE_ENV is "development", whatever `debug` says.
  it.each(['/copilotkit/cpk-debug-events', '/copilotkit/agent/default/cpk-debug-events/'])(
    'does not serve the debug event feed at %s, even in development',
    async (path) => {
      vi.stubEnv('NODE_ENV', 'development');
      try {
        const { app } = await buildTestApp();
        const res = await app.request(path, { headers: { cookie: await loginCookie(app) } });
        await res.body?.cancel();
        expect(res.status).toBe(404);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});
