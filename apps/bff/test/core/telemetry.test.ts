import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const BFF_ROOT = fileURLToPath(new URL('../..', import.meta.url));

describe('telemetry bootstrap', () => {
  it('still exits on SIGTERM once the SDK has flushed', async () => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--import', './src/core/telemetry.ts', '-e', "setInterval(() => {}, 1000); console.log('up')"],
      // Port 9 (discard) is never an OTLP collector, so nothing is exported; the SDK still starts.
      { cwd: BFF_ROOT, env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' } },
    );
    await new Promise<void>((resolve) => child.stdout.once('data', () => resolve()));

    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.once('exit', (_code, signal) => resolve(signal)));
    child.kill('SIGTERM');
    expect(await exited).toBe('SIGTERM');
  }, 15_000);
});
