import { z } from 'zod';

const configSchema = z.object({
  port: z.coerce.number().int().positive().default(8100),
  logLevel: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  idpIssuer: z.url().default('http://localhost:3000'),
  idpJwksUrl: z.url().default('http://localhost:3000/.well-known/jwks.json'),
  idpTokenUrl: z.url().default('http://localhost:3000/token'),
  /** The gateway's own credential at the IdP's token endpoint (client `mcp-gateway`). */
  clientSecret: z.string().min(16),
  accountsUrl: z.url().default('http://localhost:8101/mcp'),
  paymentsUrl: z.url().default('http://localhost:8102/mcp'),
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return configSchema.parse({
    port: env.MCP_GATEWAY_PORT,
    logLevel: env.LOG_LEVEL,
    idpIssuer: env.IDP_ISSUER,
    idpJwksUrl: env.IDP_JWKS_URL,
    idpTokenUrl: env.IDP_TOKEN_URL,
    clientSecret: env.MCP_GATEWAY_CLIENT_SECRET,
    accountsUrl: env.MCP_ACCOUNTS_URL,
    paymentsUrl: env.MCP_PAYMENTS_URL,
  });
}
