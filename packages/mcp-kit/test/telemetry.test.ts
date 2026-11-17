import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const KIT_ROOT = fileURLToPath(new URL('..', import.meta.url));
const run = promisify(execFile);

describe('telemetry bootstrap', () => {
  // The services are ESM: without the loader hook, an `import` of node:http is never instrumented and traces vanish.
  it('instruments http imported from ESM', async () => {
    const { stdout } = await run(
      process.execPath,
      [
        '--import',
        './src/telemetry.ts',
        '--input-type=module',
        '-e',
        "const { request } = await import('node:http'); console.log(Boolean(request.__wrapped)); process.exit(0)",
      ],
      // Port 9 (discard) is never an OTLP collector, so nothing is exported; the SDK still starts.
      { cwd: KIT_ROOT, env: { ...process.env, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:9' } },
    );
    expect(stdout.trim()).toBe('true');
  }, 15_000);
});
