// Loaded with `node --import` so instrumentation patches http/undici before the app imports them.
import { register } from 'node:module';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';

// Without an endpoint (unit tests, a bare local run) nothing is exported.
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  // The app is ESM; without this loader hook the http server instrumentation never sees its imports.
  register('@opentelemetry/instrumentation/hook.mjs', import.meta.url);
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.url === '/health' }),
      new UndiciInstrumentation(),
    ],
  });
  sdk.start();
  // Flush, then exit: a SIGTERM listener otherwise replaces Node's default exit and the process hangs.
  process.once('SIGTERM', () => void sdk.shutdown().finally(() => process.exit(0)));
}
