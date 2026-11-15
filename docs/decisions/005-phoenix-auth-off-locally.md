# 005 — Phoenix auth off for local runs

## Context
Phoenix 21 enables auth by default, so OTLP exports from the BFF and bot were rejected with 401.
Turning it on would need a system API key created in the Phoenix UI and shared with every service.

## Decision
Set `PHOENIX_ENABLE_AUTH=false` in `infra/docker-compose.yml`. Phoenix binds to 127.0.0.1 only, and spans
carry no prompt or completion content (`InstrumentationSettings(include_content=False)` until Phase 6
adds redaction).

## Consequences
Anyone with local access can read traces, which hold only synthetic, content-free data. Any shared or
hosted Phoenix must turn auth back on and pass `OTEL_EXPORTER_OTLP_HEADERS` with an API key.
