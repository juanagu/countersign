import { z } from 'zod';

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(3000),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** `iss` of every token the mock IdP signs; the bot and MCP servers check it. */
  idpIssuer: z.url().default('http://localhost:3000'),
  botAgentUrl: z.url().default('http://localhost:8000/agent'),
  /** The thread log: run events, owners and run leases (docs/decisions/015-resumable-streams.md). */
  redisUrl: z.url().default('redis://localhost:6379'),
  /** Set to true behind HTTPS; local dev runs on plain HTTP. */
  cookieSecure: z.stringbool().default(false),
  /** Secret the bot authenticates with at the token endpoint. */
  botClientSecret: z.string().min(16),
  /** Mock IdP step-up PIN (synthetic; the brief fixes it at 123456). */
  stepUpPin: z
    .string()
    .regex(/^[0-9]{6}$/)
    .default('123456'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse({
    port: env.BFF_PORT,
    logLevel: env.LOG_LEVEL,
    idpIssuer: env.IDP_ISSUER,
    botAgentUrl: env.BOT_AGENT_URL,
    redisUrl: env.REDIS_URL,
    cookieSecure: env.COOKIE_SECURE,
    botClientSecret: env.BOT_CLIENT_SECRET,
    stepUpPin: env.STEP_UP_PIN,
  });
}
