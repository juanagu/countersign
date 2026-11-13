# guardrails

Input, output and log/trace guardrails for each run (security rules 5–8; ADR 014). Checks are pluggable and
return a `Verdict`: allow, redact (with the redacted text) or block (with a reason and, for input, a safe reply).

## Exposed interface

- `Guardrails(classifier, write_intent)`, `Guardrails.on_model(GUARD_MODEL)`; `.start_run(user_id,
  customer_messages, third_party_text_seen) -> RunGuard` starts the input classifier in the background.
- `RunGuard` (in `BotDeps.guard`): `input_verdict()` (the gate), `record_tool_result()`, `evidence`,
  `third_party_text_seen`, `write_intent`, `customer_messages`. `RunGuard.unchecked()` is the blocked default.
- `guarded_stream(events, guard, thread_id, run_id, cancel_run)`: holds AG-UI events until the verdict, then
  runs them through `OutputGuard`; on block cancels the run and sends the safe reply.
- `OutputGuard(evidence)`: sentence buffering, `pii_leak_check`, `grounding_check`, A2UI surface grounding.
- `pii.redact()`, `redact_value()`, `pii_check()`; `messages.redact_customer_turns()`, `customer_texts()`.
- `RedactingFilter` (logging) and `RedactingSpanExporter` (OpenTelemetry), wired in `app/main.py`.
- `SAFE_REPLIES` (Spanish replies per blocked category), metric names `guardrail.*`.

## Data flow

Request → adapter masks PII in customer turns → `Guardrails.start_run` (classifier on `GUARD_MODEL`, in the
background) → agent run in its own task. `PolicyToolset` awaits the verdict above T0, records each domain-tool
result as evidence, and re-evaluates writes after third-party text with the write-intent check. The stream
forwards `RUN_STARTED`, holds the rest until the verdict, then releases text a sentence at a time after the PII
and grounding checks. Logs pass `RedactingFilter`; agent spans carry no content (`include_content=False`, ADR 014) and every
span passes `RedactingSpanExporter` before Phoenix.

## Evals

`evals/redteam.yaml` + `evals/redteam.py` (`make redteam`) drive the live stack through the BFF;
`evals/pii_scan.py` (`make pii-scan`) greps container logs and Phoenix spans for the seed's PII, names included.
