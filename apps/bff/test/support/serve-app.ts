import { serve, type ServerType } from '@hono/node-server';
import type { AddressInfo } from 'node:net';
import type { Hono } from 'hono';

/** Serves the app on a real socket, so a test can drop the connection the way a browser would. */
export async function serveApp(app: Hono): Promise<{ base: string; server: ServerType }> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info: AddressInfo) =>
      resolve({ base: `http://127.0.0.1:${info.port}`, server }),
    );
  });
}
