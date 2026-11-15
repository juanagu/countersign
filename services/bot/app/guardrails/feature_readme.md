# guardrails

Input, output and log/trace guardrails for each run (security rules 5–8; ADR 014). Checks are pluggable and
return a `Verdict`: allow, redact (with the redacted text) or block (with a reason and, for input, a safe reply).

## Exposed interface

- `Guardrails(classifier, write_intent)`, `Guardrails.on_model(guard chain)` (`GUARD_MODEL` then
  `GUARD_MODEL_FALLBACKS`, ADR 018); `.start_run(user_id,
  customer_messages, third_party_text_seen) -> RunGuard` starts the input classifier in the background.
- `RunGuard` (in `BotDeps.guard`): `input_verdict()` (the gate), `record_tool_result()`, `evidence`,
  `third_party_text_seen`, `write_intent`, `customer_messages`. `RunGuard.unchecked()` is the blocked default.
- `guarded_stream(events, guard, thread_id, run_id, cancel_run, delegates)`: holds AG-UI events until the verdict, then
  runs them through `OutputGuard`; on block cancels the run and sends the safe reply. `refusal_shown(guard)`
  awaits the verdict and returns that reply, or `None` when the answer goes out (the run's save uses it).
- `PendingApprovals` (`Guardrails.pending_approvals`): `record()` / `consume()` the approval interrupts raised per
  user and thread; `recording_interrupts(events, pending, key)` records those a run ends with. Only a resume that
  consumes them skips the classifier.
- `OutputGuard(evidence, delegates=, status_calls=)`: sentence buffering, `image_check` (`images.strip_images`), `pii_leak_check`, `grounding_check`, A2UI surface PII masking and
  grounding, and a safe `RUN_ERROR` message.
- `pii.redact()`, `redact_value()`, `pii_check()`; `messages.redact_customer_turns()`, `customer_texts()`,
  `tool_returns_in(messages, delegates=)` (each tool result, the `evidence_record()` entries of a delegate tool's
  return included; no other tool's record is read), `tools_returned_in()`, `tool_results_in()`,
  `customer_spoke_since_last_response()`. `delegates` is always the registry's delegate tool names, passed in by the
  caller, never a name pattern.
- `output_guard.is_server_only(tool, delegates)`: `render_ui` and each delegate tool; their `TOOL_CALL_*` events are
  withheld.
- `write_intent.RECENT_MESSAGES` (3): how many of the customer's latest messages a write is judged on; a subagent's
  prompt shows as many.
- `history_guard.py`, the output guard over stored history: `grounds_no_figure(tool, delegates)` (`load_skill`,
  `render_ui` and each delegate tool: their results ground no figure; a subagent's tool results ground through the
  delegate return's evidence record), and `StoredAnswers(clock, delegates=)`, which walks a stored history (`read(message)`) and
  returns each answer as the guard's deterministic checks released it (`released(text, answer)`): PII masking
  and grounding against the tool results before it, the customer's latest message and the bank's day in
  `clock`'s zone. For the reload transcript.
- `RedactingFilter` (logging) and `RedactingSpanExporter` (OpenTelemetry), wired in `app/main.py`.
- `SAFE_REPLIES` (Spanish replies per blocked category), metric names `guardrail.*`.
- `StreamTimer` (`stream_timing.py`): `guarded_stream` records a `bot.stream` span per run with the time to the
  first text delta and the first UI surface the client receives, plus `bot.models_served` and `bot.failovers` from
  the run's LLM record (ADR 018); no content. Read by `make metrics`.

## Data flow

Request → adapter masks PII in customer turns → `Guardrails.start_run` (classifier on `GUARD_MODEL`, in the
background) → agent run in its own task. `PolicyToolset` awaits the verdict above T0, records each domain-tool
result as evidence, and re-evaluates writes after third-party text with the write-intent check. The stream
forwards `RUN_STARTED`, holds the rest until the verdict, then releases text a sentence at a time after the image, PII
and grounding checks. Logs pass `RedactingFilter`; agent spans carry no content (`include_content=False`, ADR 014) and every
span passes `RedactingSpanExporter` before Phoenix.

## Evals

`evals/redteam.yaml` + `evals/redteam.py` (`make redteam`) drive the live stack through the BFF and are part of
`make eval` (Scenario 4, ADR 016); `evals/pii_scan.py` (`make pii-scan`) greps container logs and Phoenix spans for
the seed's PII, names included; `evals/metrics.py` (`make metrics`) reads the `bot.stream` spans and the
`guardrail.*` log lines.
