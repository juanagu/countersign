import { HttpAgent } from '@ag-ui/client';
import { CopilotRuntime } from '@copilotkit/runtime/v2';
import { createCopilotHonoHandler } from '@copilotkit/runtime/v2/hono';
import { Hono } from 'hono';
import { readSession, requireSession, type SessionEnv } from '../idp/session.js';
import type { TokenIssuer } from '../idp/token-issuer.js';

export const COPILOT_BASE_PATH = '/copilotkit';
export const AGENT_ID = 'default';

export interface ChatRoutesOptions {
  issuer: TokenIssuer;
  botAgentUrl: string;
}

export function chatRoutes({ issuer, botAgentUrl }: ChatRoutesOptions): Hono<SessionEnv> {
  const runtime = new CopilotRuntime({
    // One agent per request, carrying a bot token minted for this user only.
    agents: async ({ request }) => {
      const session = await readSession(issuer, request);
      if (!session) throw new Error('unauthenticated');
      const botToken = await issuer.issueBotToken(session);
      return {
        [AGENT_ID]: new HttpAgent({ url: botAgentUrl, headers: { Authorization: `Bearer ${botToken}` } }),
      };
    },
  });

  const app = new Hono<SessionEnv>();
  app.use(`${COPILOT_BASE_PATH}/*`, requireSession(issuer));
  app.route('/', createCopilotHonoHandler({ runtime, basePath: COPILOT_BASE_PATH }));
  return app;
}
