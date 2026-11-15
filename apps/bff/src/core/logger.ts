import { pino, type Logger } from 'pino';

export function createLogger(level: string): Logger {
  return pino({
    name: 'bff',
    level,
    // Tokens and cookies never reach the logs.
    redact: ['req.headers.authorization', 'req.headers.cookie', '*.token', '*.accessToken'],
  });
}
