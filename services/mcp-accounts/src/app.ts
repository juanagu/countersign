import { Hono } from 'hono';

export const SERVICE_NAME = 'mcp-accounts';

export function createApp(): Hono {
  const app = new Hono();
  app.get('/health', (c) => c.json({ status: 'ok', service: SERVICE_NAME }));
  return app;
}
