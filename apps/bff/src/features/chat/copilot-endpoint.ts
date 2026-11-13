import { HttpAgent } from '@ag-ui/client';
import { CopilotRuntime, createCopilotRuntimeHandler } from '@copilotkit/runtime/v2';
import { Hono } from 'hono';
import { readSession, requireSession, type SessionEnv } from '../idp/session.js';
import type { TokenIssuer } from '../idp/token-issuer.js';

export const COPILOT_BASE_PATH = '/copilotkit';
export const AGENT_ID = 'default';

export interface ChatRoutesOptions {
  issuer: TokenIssuer;
  botAgentUrl: string;
}

async function sessionOrThrow(issuer: TokenIssuer, request: Request) {
  const session = await readSession(issuer, request);
  if (!session) throw new Error('unauthenticated');
  return session;
}

export function chatRoutes({ issuer, botAgentUrl }: ChatRoutesOptions): Hono<SessionEnv> {
  const runtime = new CopilotRuntime({
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
  app.use(`${COPILOT_BASE_PATH}/*`, requireSession(issuer));
  app.all(`${COPILOT_BASE_PATH}/*`, (c) => handler(c.req.raw));
  return app;
}
