import { z } from 'zod';

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(8101),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse({ port: env.MCP_ACCOUNTS_PORT, logLevel: env.LOG_LEVEL });
}
