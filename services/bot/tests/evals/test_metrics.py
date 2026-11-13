"""`make metrics` reads the right spans and log lines."""

import json

from evals.metrics import FIRST_SURFACE, TTFT, guardrail_counts, latencies, percentile, tokens_per_run


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
