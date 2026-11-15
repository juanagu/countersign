import { HttpAgent } from '@ag-ui/client';
import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime/v2';
import { Hono } from 'hono';
import type { Logger } from 'pino';
import { readSession, requireSession, type SessionEnv } from '../idp/session.js';
import type { TokenIssuer } from '../idp/token-issuer.js';
import { DurableAgentRunner } from './runner/durable-agent-runner.js';
import { BotThreadHistory } from './runner/thread-history.js';
import type { ThreadLog } from './runner/thread-log.js';

export const COPILOT_BASE_PATH = '/copilotkit';
export const AGENT_ID = 'default';

export interface ChatRoutesOptions {
  issuer: TokenIssuer;
  botAgentUrl: string;
  /** Where threads live between requests and across BFF restarts (Redis in the stack). */
  threadLog: ThreadLog;
  logger: Logger;
}

// CopilotKit serves every thread's events here under NODE_ENV=development, and no runtime option turns that off.
const DEBUG_FEED_SEGMENT = 'cpk-debug-events';

/** The runtime routes on the last path segment, so the feed answers under any path that ends in it. */
function isDebugFeed(request: Request): boolean {
  return new URL(request.url).pathname.split('/').filter(Boolean).at(-1) === DEBUG_FEED_SEGMENT;
}

async function sessionOrThrow(issuer: TokenIssuer, request: Request) {
  const session = await readSession(issuer, request);
  if (!session) throw new Error('unauthenticated');
  return session;
}

export function chatRoutes({ issuer, botAgentUrl, threadLog, logger }: ChatRoutesOptions): Hono<SessionEnv> {
  const history = new BotThreadHistory(issuer, botAgentUrl, logger);
  const runtime = new CopilotRuntime({
    runner: new DurableAgentRunner({ log: threadLog, history, logger }),
    // One agent per request, carrying a bot token minted for this user only.
    agents: async ({ request }) => {
      const botToken = await issuer.issueBotToken(await sessionOrThrow(issuer, request));
      return {
        [AGENT_ID]: new HttpAgent({ url: botAgentUrl, headers: { Authorization: `Bearer ${botToken}` } }),
      };
    },
    // Without an identity a thread id is a bearer capability; with it, threads belong to their user.
    identifyUser: async (request) => {
      const { sub, name } = await sessionOrThrow(issuer, request);
      return { id: sub, name };
    },
  });
  // The browser reaches the BFF same-origin through /api, so no CORS headers are sent at all.
  const handler = createCopilotRuntimeHandler({ runtime, basePath: COPILOT_BASE_PATH, cors: false });

  const app = new Hono<SessionEnv>();
  app.use(`${COPILOT_BASE_PATH}/*`, async (c, next) => (isDebugFeed(c.req.raw) ? c.notFound() : next()));
  app.use(`${COPILOT_BASE_PATH}/*`, requireSession(issuer));
  app.all(`${COPILOT_BASE_PATH}/*`, (c) => handler(c.req.raw));
  return app;
}
