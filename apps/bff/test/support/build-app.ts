import { pino } from 'pino';
import { createApp, type AppDeps } from '../../src/app.js';
import { TokenIssuer } from '../../src/features/idp/token-issuer.js';
import { MemoryThreadLog } from './memory-thread-log.js';

export const TEST_ISSUER = 'http://idp.test';
export const TEST_BOT_SECRET = 'test-bot-secret-0123456789';

export const silentLogger = pino({ level: 'silent' });

/** App dependencies for tests: an in-memory thread log and a silent logger unless overridden. */
export function testDeps(issuer: TokenIssuer, overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    issuer,
    botAgentUrl: 'http://bot.invalid/agent',
    cookieSecure: false,
    clients: { bot: TEST_BOT_SECRET },
    stepUpPin: '123456',
    threadLog: new MemoryThreadLog(),
    logger: silentLogger,
    ...overrides,
  };
}

export async function buildTestApp(botAgentUrl = 'http://bot.invalid/agent', overrides: Partial<AppDeps> = {}) {
  const issuer = await TokenIssuer.create(TEST_ISSUER);
  const deps = testDeps(issuer, { botAgentUrl, ...overrides });
  return { app: createApp(deps), issuer, deps };
}

/** Logs in through the real route and returns the Cookie header value. */
export async function loginCookie(app: Awaited<ReturnType<typeof buildTestApp>>['app'], username = 'ana') {
  const res = await app.request('/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}
