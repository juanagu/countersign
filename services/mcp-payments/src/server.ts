import { serve } from '@hono/node-server';
import { pino } from 'pino';
import { createApp, SERVICE_NAME } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const logger = pino({ name: SERVICE_NAME, level: config.logLevel });

serve({ fetch: createApp().fetch, port: config.port }, (info) => {
  logger.info({ port: info.port }, 'listening');
});
