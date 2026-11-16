import { HttpAgent } from '@ag-ui/client';
import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime/v2';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { readSession, requireSession, type SessionDeps, type SessionEnv } from '../idp/session.js';
import { DurableAgentRunner } from './runner/durable-agent-runner.js';
import { BotThreadHistory } from './runner/thread-history.js';
import type { ThreadLog } from './runner/thread-log.js';

export const COPILOT_BASE_PATH = '/copilotkit';
export const AGENT_ID = 'default';

// The runtime parses run bodies with zod 3, whose memory-exhaustion advisory is accepted on the condition
// that no request can carry an oversized collection.
export const MAX_RUN_BODY_BYTES = 1024 * 1024;

export interface ChatRoutesOptions extends SessionDeps {
  botAgentUrl: string;
  /** Where threads live between requests and across BFF restarts (Redis in the stack). */
  threadLog: ThreadLog;
}

// CopilotKit serves every thread's events here under NODE_ENV=development, and no runtime option turns that off.
const DEBUG_FEED_SEGMENT = 'cpk-debug-events';

/** The runtime routes on the last path segment, so the feed answers under any path that ends in it. */
function isDebugFeed(request: Request): boolean {
  return new URL(request.url).pathname.split('/').filter(Boolean).at(-1) === DEBUG_FEED_SEGMENT;
}

async function sessionOrThrow(deps: SessionDeps, request: Request) {
  const session = await readSession(deps, request);
  if (!session) throw new Error('unauthenticated');
  return session;
}

export function chatRoutes(options: ChatRoutesOptions): Hono<SessionEnv> {
  const { issuer, botAgentUrl, threadLog, logger } = options;
  const history = new BotThreadHistory(issuer, botAgentUrl, logger);
  const runtime = new CopilotRuntime({
    runner: new DurableAgentRunner({ log: threadLog, history, logger }),
    // One agent per request, carrying a bot token minted for this user only.
    agents: async ({ request }) => {
      const botToken = await issuer.issueBotToken(await sessionOrThrow(options, request));
      return {
        [AGENT_ID]: new HttpAgent({ url: botAgentUrl, headers: { Authorization: `Bearer ${botToken}` } }),
      };
    },
    // Without an identity a thread id is a bearer capability; with it, threads belong to their user.
    identifyUser: async (request) => {
      const { sub, name } = await sessionOrThrow(options, request);
      return { id: sub, name };
    },
  });
  // The browser reaches the BFF same-origin through /api, so no CORS headers are sent at all.
  const handler = createCopilotRuntimeHandler({ runtime, basePath: COPILOT_BASE_PATH, cors: false });

  const app = new Hono<SessionEnv>();
  app.use(`${COPILOT_BASE_PATH}/*`, async (c, next) => (isDebugFeed(c.req.raw) ? c.notFound() : next()));
  app.use(`${COPILOT_BASE_PATH}/*`, requireSession(options));
  app.use(`${COPILOT_BASE_PATH}/*`, bodyLimit({ maxSize: MAX_RUN_BODY_BYTES }));
  app.all(`${COPILOT_BASE_PATH}/*`, (c) => handler(c.req.raw));
  return app;
}
