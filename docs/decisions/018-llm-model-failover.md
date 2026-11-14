# 018 — LLM failover in process: a `FallbackModel` chain per role, a first-event deadline and a circuit breaker

**Status:** accepted; tasks 1–4 built (commits 608d160, f32459c). Task 5 ran live on 2026-11-14 (results below).

As built: the fault spec is `target:fault`, where target is `orchestrator`, `guard`, `primary` (both roles' primaries) or
`all` (every model in both chains), and 429/529/503/500 are accepted as fault aliases. The guard deadline is
`GUARD_REQUEST_TIMEOUT_SECONDS` (default 6). Breakers are keyed by model name and shared by both roles.

## Context
The user wants a backup for when a model fails or its latency spikes. The orchestrator (`BOT_MODEL`) streams
through `AGUIAdapter`. The guard model (`GUARD_MODEL`) drives the input classifier and the write-intent check.
Both fail closed after 15 s (ADR 014), and both are non-streamed `agent.run` calls. Today each role is one model
string, and a provider 529 ends the run with `RUN_ERROR` or blocks the message. `make metrics` measured time to
first token at p50 2.5 s and p95 8.8 s (ADR 016).

Checked in the installed pydantic-ai 2.68:
- **`FallbackModel` falls back on a whole category of errors.** By default it falls back on `ModelAPIError`. Its
  subclasses separate the failures:
  - `ModelRateLimitError` (429);
  - `ModelOverloadedError` (529), under `ModelUnavailableError` (503);
  - `ModelServerError` (500/502/504);
  - `ModelConnectionError` and `ModelTimeoutError`;
  - `ModelQuotaExceededError`;
  - `ModelRequestRejectedError`, covering auth, not found and context window;
  - `ModelRequestTimeout`.
- **Two deadlines, each model getting fresh ones.** `ModelSettings` has `request_timeout`, which covers the
  whole request, and `first_event_timeout`, for streamed requests only. That one runs until the first part
  starts, a tool call or thinking included. The chain gives each model new deadlines and moves on after a
  `ModelRequestTimeout`.
- **A stream is handed over only after its first event.** An error before it falls back. An error after it
  propagates. This happens per model request, which is one step of an agent run.
- **Failed attempts are recorded.** Each becomes an ERROR span, `model request attempt <model>`, under the
  `chat` span. With `include_content=False`, its error message is left out.
- **The docs prefer the `ModelFallback` capability inside an agent.** It differs from `FallbackModel` by
  re-preparing each request per candidate, and by `sticky`, which keeps a conversation on the backup across runs.
- **Gateways.** LiteLLM proxy, Portkey and OpenRouter would each be a new service or a new paid provider in
  the model path. agentgateway (ADR 017) also has LLM routing; it was not evaluated here.

## Decision
- **In process, no gateway service.** Failover is only safe before a model request has streamed. pydantic-ai
  already draws that line at the right layer, per request and inside the run. A proxy can't see the agent's
  steps, the input gate or the output guard. It would add a hop and a new single point of failure, and break the
  rule against adding services. The user asked for a backup, not for a service.
- **One `FallbackModel` per role**, built in one place (`app/core/llm/`) and handed to every
  `Model | str` parameter. That means `build_agent`, `Guardrails.on_model`, `GuardModelClassifier` and
  `GuardModelWriteIntent` change no signatures.
  - `ModelFallback` is not used. Its per-candidate preparation serves capabilities this bot doesn't use, and
    `sticky` would keep a conversation on the backup after the primary recovers.
  - Chains come from the env: `BOT_MODEL` + `BOT_MODEL_FALLBACKS` (default `anthropic:claude-haiku-5-5`) and
    `GUARD_MODEL` + `GUARD_MODEL_FALLBACKS` (default `anthropic:claude-sonnet-5-5`). Each list is
    comma-separated and empty means no failover.
  - Any pydantic-ai model string is accepted, so a second provider needs only its key, its package extra and
    an env value.
  - The eval judges stay on the bare `GUARD_MODEL`, so scores remain comparable.
- **What fails over.**
  - Yes: rate limit, overloaded or unavailable, server error, connection error or transport timeout,
    `ModelRequestTimeout`, and an open circuit breaker.
  - No: request rejected (auth, model not found, context window) and quota or billing. Those are configuration
    errors that failover would hide, and a second model on the same account fails the same way.
  - A failure after a request's first event is not retried. The run ends with the fixed Spanish `RUN_ERROR` reply
    (ADR 014). It isn't saved (ADR 015), and the customer asks again.
- **Latency.**
  - The orchestrator has `first_event_timeout` 10 s and `request_timeout` 90 s (`LLM_FIRST_EVENT_TIMEOUT_SECONDS`,
    `LLM_REQUEST_TIMEOUT_SECONDS`).
  - The guard roles have `request_timeout` 6 s per attempt, so two attempts fit inside the 15 s fail-closed
    budget. If the whole chain fails or times out, the message is still blocked.
  - The 10 s is a starting value. Before the demo, the implementer sets it from the p99 first-event time of the
    `chat` spans. The customer-facing time to first token is a different measurement.
  - No hedging (racing a backup after a delay). It doubles the cost of every hedged request and needs custom
    concurrency in the model layer. The breaker below makes a stall cost one first-event deadline, not one per step.
- **Circuit breaker** (`CircuitBreakerModel`, a `WrapperModel` around every chain member except the last).
  - **Per run:** once a model has failed in a run, later steps of that run skip it at once. A five-step run
    therefore pays the 10 s once.
  - **Per process:** 3 failures in 60 s open the breaker for 30 s, then one request probes.
  - While a model is skipped, the wrapper raises `ModelUnavailableError(model_name, "circuit open")` before any I/O.
  - The `fallback_on` handler sees every failure with its `model_name`, including timeouts the wrapper never
    sees. It classifies the failure, records it with the breaker and logs it. The wrapper records success
    when a request ends cleanly.
- **Streaming, the guards and resume.** No event from a failed attempt is emitted, so the effect stays inside
  the bot:
  - The output guard, the grounding check and A2UI validation don't depend on the model. They apply to the
    backup's text unchanged.
  - The input gate already holds every event until its verdict.
  - The BFF's Redis log (ADR 015) receives only the answering model's events, so replay can't duplicate a
    partial answer. Each request has its own deadline, so the silence the customer waits through stays one
    deadline plus the backup's first token, far under nginx's 300 s.
  - Stored history keeps each `ModelResponse` with the model that answered it. The next run starts again with
    the primary.
- **Observability.**
  - Each failover logs one line, `metric: "llm.failover"`, with `role` (`orchestrator` or `guard`),
    `from_model` and a `reason` class: `rate_limited`, `overloaded`, `unavailable`, `server_error`,
    `connection`, `first_event_timeout`, `request_timeout` or `circuit_open`. The reason comes from the
    exception class, never its message.
  - The breaker logs `llm.circuit.opened` and `llm.circuit.closed`.
  - A per-run record (a context variable set in `chat/routes.py` before the guard and the run start) adds
    `bot.models_served` and `bot.failovers` to the `bot.stream` span.
  - `make metrics` adds two tables: runs by served model with their time-to-first-token p50/p95, and failovers
    by role and reason.
- **Fault injection for tests and the demo.** A `FaultyModel` wrapper is enabled only by
  `LLM_FAULT_INJECTION` (for example `orchestrator:overloaded`, `orchestrator:stall`, `guard:rate_limited`,
  `orchestrator:after_first_event`). The bot logs a warning at startup when it is set. Unit tests use it
  around `FunctionModel` fakes with millisecond deadlines. `make failover-demo FAULT=…` restarts the bot with
  the fault, and `make eval-backup` runs the live suite with the primaries forced to fail.

## Consequences
- Same provider, same account. Anthropic-only chains cover a model being overloaded, rate-limited or slow.
  They don't cover the API, the network path or the account being down. A second provider covers that, at the
  cost of a new key, a new paid account, another processor of the (synthetic) data, and different tool-calling
  and A2UI behaviour. Claude on a cloud provider would keep the model family.
- The backup must pass the evals to count as one. Haiku is weaker at tool selection and A2UI trees, and a
  Sonnet guard classifies differently, so `make eval-backup` records whether the backup meets the gates.
- Breaker state is per process, like the guardrail caps (ADR 014).
- The fault-injection env var must stay empty outside local runs. Nothing but review enforces that.

## Live results (2026-11-14)
- `make failover-demo FAULT=orchestrator:stall`: the first request hit `first_event_timeout` at 10 s and Haiku
  answered with the correct balances and card; the breaker then skipped Sonnet up front (`circuit_open`) until
  the fault was removed. `orchestrator:529` failed over the same way in about 6 s end to end.
- `make eval-backup` (both primaries forced to fail): 6/7 gates. Scenarios 4/4, KB grounding 5/5, tool
  selection 6/6, citation judge 1.00, red team 27/27, controls 3/3; the quality judge scored 0.75 against the
  0.80 gate (Haiku sometimes points at the card or is terser).
- Calibration: across five full `make eval` runs and the e2e suite on Sonnet (several hundred model requests)
  no request tripped the 10 s first-event deadline, while run-level time to first token was p50 5.8 s / p95
  12.9 s (a run spans several requests). The 10 s default stays.


## Decided after the live run (user, 2026-11-14)
- **Backup mode has its own quality gate.** `thresholds.yaml` `backup_mode` sets `judge_quality` to 0.70 for
  `make eval-backup` (`evals.run --backup`); every other gate stays as in primary mode. A backup that answers
  correctly, safely and with citations but more tersely is accepted for the minutes an outage lasts.
- **Anthropic only.** No second provider in the POC; the chain stays Sonnet ↔ Haiku. The Consequences above
  stand: an Anthropic-wide outage takes down both.
- **The customer never sees a failover.** It shows only in logs, traces and `make metrics`.
