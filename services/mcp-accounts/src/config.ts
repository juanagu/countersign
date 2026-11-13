import { z } from 'zod';

export const DEFAULT_BANK_TIMEZONE = 'America/Argentina/Buenos_Aires';

function isTimeZone(name: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(8101),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  idpIssuer: z.url().default('http://localhost:3000'),
  idpJwksUrl: z.url().default('http://localhost:3000/.well-known/jwks.json'),
  databaseUrl: z.string().min(1).default('postgres://bank:bank@localhost:5432/bank'),
  // Day boundaries ("today", "el mes pasado") are the bank's local days, the same zone the bot uses.
  bankTimeZone: z.string().refine(isTimeZone, 'not an IANA time zone').default(DEFAULT_BANK_TIMEZONE),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse({
    port: env.MCP_ACCOUNTS_PORT,
    logLevel: env.LOG_LEVEL,
    idpIssuer: env.IDP_ISSUER,
    idpJwksUrl: env.IDP_JWKS_URL,
    databaseUrl: env.DATABASE_URL,
    bankTimeZone: env.BANK_TIMEZONE,
  });
}
