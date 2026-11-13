import { z } from 'zod';

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(8101),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  idpIssuer: z.url().default('http://localhost:3000'),
  idpJwksUrl: z.url().default('http://localhost:3000/.well-known/jwks.json'),
  databaseUrl: z.string().min(1).default('postgres://bank:bank@localhost:5432/bank'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse({
    port: env.MCP_ACCOUNTS_PORT,
    logLevel: env.LOG_LEVEL,
    idpIssuer: env.IDP_ISSUER,
    idpJwksUrl: env.IDP_JWKS_URL,
    databaseUrl: env.DATABASE_URL,
  });
}
