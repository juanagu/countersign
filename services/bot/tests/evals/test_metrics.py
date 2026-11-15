"""`make metrics` reads the right spans and log lines."""

import json
from typing import Any

from evals.metrics import (
    FIRST_SURFACE,
    TTFT,
    UNRECORDED,
    cache_read_share,
    failover_counts,
    guardrail_counts,
    latencies,
    percentile,
    tokens_per_run,
    ttft_by_served_model,
)

INPUT, CACHED = "gen_ai.usage.input_tokens", "gen_ai.usage.details.cache_read_input_tokens"


def _span(name: str, trace: str, **attributes: float) -> dict[str, object]:
    return {"name": name, "context": {"trace_id": trace}, "attributes": attributes}


def test_percentiles_use_the_nearest_rank() -> None:
    values = [float(v) for v in range(1, 101)]
    assert percentile(values, 0.5) == 50
    assert percentile(values, 0.95) == 95
    assert percentile([], 0.5) is None


def test_latencies_skip_runs_without_text_or_surface() -> None:
    runs = [
        _span("bot.stream", "a", **{TTFT: 900.0}),
        _span("bot.stream", "b", **{TTFT: 1200.0, FIRST_SURFACE: 2000.0}),
    ]
    assert latencies(runs) == {TTFT: [900.0, 1200.0], FIRST_SURFACE: [2000.0]}


def test_tokens_add_up_per_run_and_ignore_the_sdk_spans() -> None:
    runs = [_span("bot.stream", "a"), _span("bot.stream", "b")]
    models = [
        _span("chat claude-sonnet-5-5", "a", **{"llm.token_count.total": 6000}),
        _span("chat claude-haiku-5-5", "a", **{"llm.token_count.total": 500}),
        _span("anthropic.messages.create", "a", **{"llm.token_count.total": 6000}),  # the same call, again
        _span("chat claude-sonnet-5-5", "b", **{"llm.token_count.total": 100}),
    ]
    assert tokens_per_run(runs, models) == [6500.0, 100.0]


def test_cache_share_counts_model_requests_only() -> None:
    models = [
        _span("chat claude-sonnet-5-5", "a", **{INPUT: 6000, CACHED: 4500}),
        _span("chat claude-haiku-5-5", "a", **{INPUT: 2000}),
        _span("anthropic.messages.create", "a", **{INPUT: 6000, CACHED: 6000}),
    ]
    assert cache_read_share(models) == 4500 / 8000
    assert cache_read_share([]) is None


def test_guardrail_counts_by_metric_and_category() -> None:
    lines = [
        "bot-1  | " + json.dumps({"metric": "guardrail.input.blocked", "category": "jailbreak"}),
        "bot-1  | " + json.dumps({"metric": "guardrail.input.blocked", "category": "jailbreak"}),
        "bot-1  | " + json.dumps({"metric": "guardrail.output.ungrounded", "reason": "1 figure(s)"}),
        "bot-1  | " + json.dumps({"metric": "bot.stream.timing", "time_to_first_token_ms": 3.0}),
        "bot-1  | not json {",
    ]
    counts = guardrail_counts("\n".join(lines))
    assert counts == {"guardrail.input.blocked [jailbreak]": 2, "guardrail.output.ungrounded": 1}


def test_runs_group_by_the_orchestrator_model_that_served_them() -> None:
    def run(served: list[str] | None, ttft: float | None) -> dict[str, Any]:
        attributes: dict[str, Any] = {} if ttft is None else {TTFT: ttft}
        if served is not None:
            attributes["bot.models_served"] = served
        return {"attributes": attributes}

    spans = [
        run(["guard:claude-haiku-5-5", "orchestrator:claude-sonnet-5-5"], 900),
        run(["orchestrator:claude-haiku-5-5"], 1500),
        run(["orchestrator:claude-haiku-5-5"], None),
        run(None, 700),
    ]
    assert ttft_by_served_model(spans) == {
        "claude-sonnet-5-5": [900.0],
        "claude-haiku-5-5": [1500.0],
        UNRECORDED: [700.0],
    }


def test_failovers_count_by_role_and_reason_from_the_log_lines() -> None:
    def line(**fields: Any) -> str:
        return "bot-1  | " + json.dumps({"level": "warning", "msg": "model failed over", **fields})

    logs = "\n".join(
        [
            line(metric="llm.failover", role="orchestrator", reason="overloaded"),
            line(metric="llm.failover", role="orchestrator", reason="overloaded"),
            line(metric="llm.failover", role="guard", reason="first_event_timeout"),
            line(metric="llm.circuit.opened", model="claude-sonnet-5-5"),
            line(metric="guardrail.input.blocked", category="off_topic"),
        ]
    )
    assert failover_counts(logs) == {"orchestrator overloaded": 2, "guard first_event_timeout": 1}
