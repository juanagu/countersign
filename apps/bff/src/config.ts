import { z } from 'zod';

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** `iss` of every token the mock IdP signs; the bot and MCP servers check it. */
  idpIssuer: z.url().default('http://localhost:3000'),
  botAgentUrl: z.url().default('http://localhost:8000/agent'),
  /** Set to true behind HTTPS; local dev runs on plain HTTP. */
  cookieSecure: z.stringbool().default(false),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse({
    port: env.BFF_PORT,
    logLevel: env.LOG_LEVEL,
    idpIssuer: env.IDP_ISSUER,
    botAgentUrl: env.BOT_AGENT_URL,
    cookieSecure: env.COOKIE_SECURE,
  });
}
