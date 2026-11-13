# 014 — Guardrails: a per-run input gate, a sentence-buffered output guard, and redaction at the exporters

## Context
Phase 6 asks for input, tool-policy and output guardrails on a streamed AG-UI run, with logs and traces free of
PII (security rules 5–8). The classifier must run concurrently with the first orchestrator call, yet no personal
tool may run, and no text may reach the client, before its verdict.

## Decision
- **Pluggable checks** (`app/guardrails/`) return a `Verdict`: allow, redact (with the redacted text) or block
  (with a reason and, for input, the safe Spanish reply).
- **Input:** regex + checksum PII detection (Luhn for cards, mod-11 for CUIL/CUIT, DNI only next to its keyword,
  22-digit CBUs, `NNNN-NNNN-NNNN` accounts, emails, phones except 0800 lines, JWTs and bearer tokens). The
  adapter masks PII in every customer turn before the classifier, the model, logs or traces see it. The
  classifier is a structured-output Pydantic AI agent on `GUARD_MODEL` (categories: ok, prompt_injection,
  jailbreak, other_customer_data, credentials, off_topic). It fails closed: an error or a 15 s timeout blocks.
- **The gate is a `RunGuard` in `BotDeps`**, one per run, holding an `asyncio.Event` for the verdict. It is the
  one object both sides of the run can reach: the tool policy runs inside the agent run and sees only `deps`;
  the output stream runs outside it and is built with the same `deps`. `PolicyToolset` awaits the verdict before
  any tool above T0, so T0 tools (`load_skill`, `search_knowledge`, `render_ui`) start right away and nothing
  personal runs on a blocked message. A `BotDeps` built without the pipeline gets `RunGuard.unchecked()`, which
  is blocked: a script or a test that forgets the gate can't reach personal data.
- **The stream:** the route builds the adapter with `from_request`, wraps `run_stream(...)` and returns
  `streaming_response(...)` (the steps `dispatch_request` performs, verified in pydantic-ai 2.68's
  `ui/_adapter.py`). The agent run is driven by its own task into a queue, so its tracing context stays in one
  task and the first model call overlaps the classifier. Until the verdict only `RUN_STARTED` is forwarded;
  on block the run is cancelled with a `CancellationToken` and the client gets a complete safe reply
  (text start/content/end, `RUN_FINISHED`).
- **Tool policy:** per-conversation caps (user + AG-UI `threadId`, in memory, sliding 10-minute window): 5 T2 and
  3 T3 calls. A write (T2/T3) in a conversation that holds third-party free text (`list_transactions` memos and
  merchants, `search_knowledge` passages), in this run or in the client's history, is re-evaluated by a guard-model
  check: do the customer's last three messages ask for this exact action, recipient and amount? Denied
  otherwise, and on any error. A T3 call that needs approval skips it, before and after the approval: its only
  argument is a draft id, which the judge can't match to the customer's words, so it would deny every transfer
  and the interrupt would never be raised. The customer's approval of the server-rendered card plus step-up is
  that call's fresh evaluation, and the draft it names came from `prepare_transfer` (T2), which is re-evaluated.
- **Output:** text deltas are released a sentence at a time (terminal punctuation followed by whitespace, or a
  line break; a dot inside `1.254.300,50` is never followed by whitespace). Each sentence passes a PII-leak check
  (masked in place) and a grounding check: every amount (with a currency or unit, or ≥ 1000, or with decimals),
  percentage, date and account number must appear in this run's domain-tool results, recorded by
  `PolicyToolset` before the model sees them. es-AR and plain formats are normalised (`$ 1.254.300,50` ↔
  `1254300.50`, `****4521` by its last digits, `15 de octubre`, `15/10`, ISO dates). A failing sentence becomes a
  fallback; an `a2ui-surface` with an ungrounded number is dropped for a text fallback (ADR 012's promise).
  `bank-template` cards pass untouched. Each change is logged with a metric: `guardrail.input.blocked`,
  `guardrail.output.ungrounded`, `guardrail.output.pii_redacted`, `guardrail.output.surface_dropped`,
  `guardrail.policy.write_not_requested`.
- **Logs and traces:** a `logging.Filter` redacts the formatted message, every `extra=` field and exception text.
  A `RedactingSpanExporter` wraps the OTLP exporter and rebuilds each span with redacted attributes and events,
  so pydantic-ai instrumentation now runs with `include_content=True`. `setup_telemetry` requires the wrapper.

## Consequences
- Latency: text waits for the classifier (Haiku, usually done before Sonnet's first tokens) and for each
  sentence end. Streaming is per sentence rather than per token.
- Grounding also accepts figures from the customer's latest message, today's date and its year. Today is the
  bank's day (`BankClock`, the one the prompt and the policy use), not the UTC host's. Without it, a
  sentence such as "Preparo una transferencia de $ 50.000" written before the tool call would be replaced. The
  risk is echoing a customer-supplied figure as if it were the bank's; the red-team case with a fake tool result
  covers it with the input classifier and the judge.
- False positives: a figure the model computes (a sum, a date range it derives from today) is replaced by the
  fallback. Acceptable for a bank; it is visible in the logs by metric.
- Caps live in one process; a second bot replica or a new thread resets them. A shared store (Redis) is the
  follow-up if the bot scales out.
- The classifier sees only the latest customer message; a multi-turn injection split across messages relies on
  the tool policy and the output guard.
