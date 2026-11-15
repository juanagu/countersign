"""`make metrics`: latency, tokens per run and guardrail blocks, from Phoenix spans and the bot's metric logs.

Phoenix 21 has no dashboard API, so this script is the dashboard:
- time to first token and to first UI surface: the `bot.stream` span of each run (`app/guardrails/stream_timing.py`);
- tokens per run: the pydantic-ai model spans (`chat <model>`) in that run's trace, orchestrator and guard together;
- guardrail blocks: the `guardrail.*` metric log lines in `docker compose logs bot`, by kind;
- model failover (ADR 018): runs by the orchestrator model that served them (`bot.models_served` on `bot.stream`)
  with their time to first token, and the `llm.failover` log lines by role and reason.
"""

import argparse
import json
import math
import subprocess
import sys
from collections import Counter, defaultdict
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from evals.pii_scan import COMPOSE

PHOENIX_SPANS = "http://localhost:6006/v1/projects/default/spans"
PAGE_SIZE = 1000
MAX_PAGES = 200
STREAM_SPAN = "bot.stream"
TTFT = "bot.time_to_first_token_ms"
FIRST_SURFACE = "bot.time_to_first_surface_ms"
MODEL_SPAN_PREFIX = "chat "  # pydantic-ai's model-request spans; the SDK's own spans would count tokens twice
TOKENS = "llm.token_count.total"
INPUT_TOKENS = "gen_ai.usage.input_tokens"
CACHE_READ_TOKENS = "gen_ai.usage.details.cache_read_input_tokens"
GUARDRAIL_PREFIX = "guardrail."
FAILOVER_METRIC = "llm.failover"
MODELS_SERVED = "bot.models_served"
ORCHESTRATOR_PREFIX = "orchestrator:"
UNRECORDED = "(not recorded)"

Span = dict[str, Any]


def spans(since: datetime, **filters: str) -> Iterator[Span]:
    params: dict[str, str | int] = {"limit": PAGE_SIZE, "start_time": since.isoformat(), **filters}
    with httpx.Client(timeout=60) as http:
        for _ in range(MAX_PAGES):
            page = http.get(PHOENIX_SPANS, params=params).raise_for_status().json()
            yield from page["data"]
            if not page.get("next_cursor"):
                return
            params["cursor"] = page["next_cursor"]


def percentile(values: list[float], share: float) -> float | None:
    """Nearest-rank percentile; None without data."""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(share * len(ordered)) - 1)]


def summary(values: list[float]) -> str:
    p50, p95 = percentile(values, 0.5), percentile(values, 0.95)
    if p50 is None or p95 is None:
        return "no data"
    return f"p50 {p50:,.0f}  p95 {p95:,.0f}  (n={len(values)})"


def latencies(stream_spans: list[Span]) -> dict[str, list[float]]:
    found: dict[str, list[float]] = {TTFT: [], FIRST_SURFACE: []}
    for span in stream_spans:
        for name, values in found.items():
            if (value := span["attributes"].get(name)) is not None:
                values.append(float(value))
    return found


def tokens_per_run(stream_spans: list[Span], model_spans: list[Span]) -> list[float]:
    per_trace: dict[str, float] = defaultdict(float)
    for span in model_spans:
        if span["name"].startswith(MODEL_SPAN_PREFIX):
            per_trace[span["context"]["trace_id"]] += float(span["attributes"].get(TOKENS) or 0)
    return [per_trace[s["context"]["trace_id"]] for s in stream_spans if s["context"]["trace_id"] in per_trace]


def cache_read_share(model_spans: list[Span]) -> float | None:
    """Share of model input tokens served from the prompt cache; None without input."""
    model_requests = [s["attributes"] for s in model_spans if s["name"].startswith(MODEL_SPAN_PREFIX)]
    total = sum(float(a.get(INPUT_TOKENS) or 0) for a in model_requests)
    cached = sum(float(a.get(CACHE_READ_TOKENS) or 0) for a in model_requests)
    return cached / total if total else None


def metric_lines(log_text: str, prefix: str = GUARDRAIL_PREFIX) -> Iterator[dict[str, Any]]:
    for line in log_text.splitlines():
        start = line.find("{")
        if start < 0 or '"metric"' not in line:
            continue
        try:
            entry = json.loads(line[start:])
        except json.JSONDecodeError:
            continue
        if isinstance(entry, dict) and str(entry.get("metric", "")).startswith(prefix):
            yield entry


def guardrail_counts(log_text: str) -> Counter[str]:
    """Counts by metric, and by category for input blocks (injection, jailbreak, off_topic...)."""
    counts: Counter[str] = Counter()
    for entry in metric_lines(log_text):
        kind = entry["metric"] + (f" [{entry['category']}]" if entry.get("category") else "")
        counts[kind] += 1
    return counts


def served_model(span: Span) -> str:
    """The orchestrator model(s) that answered a run; a run that failed over mid-way lists both."""
    served = span["attributes"].get(MODELS_SERVED)
    if not served:
        return UNRECORDED
    models = [entry.removeprefix(ORCHESTRATOR_PREFIX) for entry in served if entry.startswith(ORCHESTRATOR_PREFIX)]
    return " + ".join(models) or UNRECORDED


def ttft_by_served_model(stream_spans: list[Span]) -> dict[str, list[float]]:
    """Runs grouped by served model, each with its time-to-first-token values (a run without text has none)."""
    found: dict[str, list[float]] = defaultdict(list)
    for span in stream_spans:
        values = found[served_model(span)]
        if (value := span["attributes"].get(TTFT)) is not None:
            values.append(float(value))
    return dict(found)


def failover_counts(log_text: str) -> Counter[str]:
    """`llm.failover` lines by role and reason class."""
    counts: Counter[str] = Counter()
    for entry in metric_lines(log_text, FAILOVER_METRIC):
        counts[f"{entry.get('role', '?')} {entry.get('reason', '?')}"] += 1
    return counts


def bot_logs(hours: float) -> str:
    command = [*COMPOSE, "logs", "--no-color", "--since", f"{hours}h", "bot"]
    run = subprocess.run(command, capture_output=True, text=True, check=True)  # noqa: S603
    return run.stdout + run.stderr


def main(hours: float) -> int:
    since = datetime.now(UTC) - timedelta(hours=hours)
    stream_spans = list(spans(since, name=STREAM_SPAN))
    model_spans = list(spans(since, span_kind="LLM"))
    timing = latencies(stream_spans)
    print(f"Runs in the last {hours:g} h (bot.stream spans): {len(stream_spans)}")
    print(f"  time to first token, ms:    {summary(timing[TTFT])}")
    print(f"  time to first surface, ms:  {summary(timing[FIRST_SURFACE])}")
    print(f"  tokens per run:             {summary(tokens_per_run(stream_spans, model_spans))}")
    share = cache_read_share(model_spans)
    print(f"  input from prompt cache:    {'no data' if share is None else f'{share:.0%}'}")
    print("Runs by served orchestrator model (time to first token, ms):")
    runs = Counter(served_model(span) for span in stream_spans)
    for model, values in sorted(ttft_by_served_model(stream_spans).items()):
        print(f"  {model:32} {runs[model]:5} runs  {summary(values)}")
    logs = bot_logs(hours)
    counts = guardrail_counts(logs)
    print(f"Guardrail events (bot logs): {sum(counts.values())}")
    for kind, count in sorted(counts.items()):
        print(f"  {count:5}  {kind}")
    failovers = failover_counts(logs)
    print(f"Model failovers by role and reason (bot logs): {sum(failovers.values())}")
    for kind, count in sorted(failovers.items()):
        print(f"  {count:5}  {kind}")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hours", type=float, default=24, help="Look back this many hours (default 24).")
    sys.exit(main(parser.parse_args().hours))
