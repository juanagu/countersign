import { createApp } from '../../src/app.js';
import { TokenIssuer } from '../../src/features/idp/token-issuer.js';

export const TEST_ISSUER = 'http://idp.test';
export const TEST_BOT_SECRET = 'test-bot-secret-0123456789';

export async function buildTestApp(botAgentUrl = 'http://bot.invalid/agent') {
  const issuer = await TokenIssuer.create(TEST_ISSUER);
  const app = createApp({ issuer, botAgentUrl, cookieSecure: false, clients: { bot: TEST_BOT_SECRET } });
  return { app, issuer };
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
