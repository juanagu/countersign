"""A CUJ run's record: one `TrialResult` per trial, the gate table, the console lines, the token bill and the JSON."""

import json
import time
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime
from pathlib import Path

import httpx
from pydantic_evals.reporting import ReportCase

from evals.cuj import Scenario
from evals.live import DiscardedAttempt, LiveInput, LiveOutput, Meta
from evals.metrics import spans, tokens_by_thread
from evals.run import Gate
from evals.thresholds import Thresholds


@dataclass(frozen=True)
class TrialResult:
    cuj_id: str
    group: str
    trial: int
    passed: bool
    failed: dict[str, str | None]
    seconds: float
    turns: int
    thread_id: str
    text: str
    calls: list[str]
    driver: str
    attempts: int
    start_ns: int
    end_ns: int
    discarded: list[DiscardedAttempt] = field(default_factory=list)


def trial_result(case: ReportCase[LiveInput, LiveOutput, Meta], trial: int) -> TrialResult:
    meta = case.metadata or {}
    failed = {name: a.reason for name, a in case.assertions.items() if not a.value}
    failed |= {f.name: f.error_message for f in case.evaluator_failures}
    return TrialResult(
        cuj_id=meta.get("id", case.name),
        group=meta.get("group", ""),
        trial=trial,
        passed=not failed,
        failed=failed,
        seconds=round(case.task_duration, 1),
        turns=case.output.turns,
        thread_id=case.output.thread_id or "",
        text=case.output.text[:300],
        calls=[f"{c.name}:{c.outcome}" for c in case.output.calls],
        driver=meta.get("driver", ""),
        attempts=case.output.attempts,
        start_ns=case.output.start_ns,
        end_ns=case.output.end_ns,
        discarded=case.output.discarded,
    )


def error_result(scenario: Scenario, trial: int, message: str) -> TrialResult:
    now = time.time_ns()
    return TrialResult(
        scenario.id, scenario.group, trial, False, {"task": message}, 0.0, 0, "", "", [], scenario.driver, 1, now, now
    )


def cuj_gates(results: list[TrialResult], thresholds: Thresholds) -> list[Gate]:
    """Per group: the share of trials that passed, and, where the group allows misses, each journey's passing trials."""
    gates: list[Gate] = []
    for group in sorted({r.group for r in results}):
        trials = [r for r in results if r.group == group]
        passed = sum(r.passed for r in trials)
        if group in thresholds.pass_rates:
            detail = f"{passed}/{len(trials)} trials"
            gates.append(Gate(group, passed / len(trials), thresholds.pass_rates[group], detail))
        else:
            gates.append(Gate(f"{group} (no threshold)", 0.0, 1.0, f"{group!r} has no pass_rates entry; add one"))
        minimum = thresholds.consistency.min_trials_passing.get(group)
        if minimum is not None:
            gates.append(_consistency_gate(group, trials, minimum))
    return gates


def _consistency_gate(group: str, trials: list[TrialResult], minimum: int) -> Gate:
    """Each journey must pass `minimum` trials. Fewer trials than that can never pass, so the minimum is clamped to the
    fewest trials any journey ran, and the detail says the gate was weakened."""
    ran: dict[str, int] = defaultdict(int)
    passing: dict[str, int] = defaultdict(int)
    for r in trials:
        ran[r.cuj_id] += 1
        passing[r.cuj_id] += r.passed
    fewest = min(ran.values())
    detail = f"passing trials per journey {dict(passing)}"
    if fewest < minimum:
        detail += f"; WEAKENED: the minimum {minimum} is clamped to the {fewest} trials run"
    return Gate(f"{group} consistency", float(min(passing.values())), float(min(minimum, fewest)), detail)


def print_results(results: list[TrialResult]) -> None:
    for r in results:
        mark = "PASS" if r.passed else "FAIL"
        retried = f", {r.attempts} attempts" if r.attempts > 1 else ""
        print(f"{mark} {r.cuj_id} trial {r.trial} ({r.seconds}s, {r.turns} turns{retried}) calls: {r.calls}")
        for attempt in r.discarded:
            print(f"     discarded attempt: {attempt.verdict}; calls: {attempt.calls}")
        for name, reason in r.failed.items():
            print(f"     failed {name}: {reason}")


def token_bill(results: list[TrialResult], since: datetime) -> dict[str, float]:
    """Tokens per journey id (orchestrator, subagent and guard models together, discarded attempts included) from
    Phoenix; empty without it."""
    try:
        stream = list(spans(since, name="bot.stream"))
        models = list(spans(since, span_kind="LLM"))
    except httpx.HTTPError:
        return {}
    by_thread = tokens_by_thread(stream, models)
    bill: dict[str, float] = defaultdict(float)
    for r in results:
        threads = [r.thread_id, *(a.thread_id for a in r.discarded)]
        bill[r.cuj_id] += sum(by_thread.get(thread, 0.0) for thread in threads)
    return dict(bill)


def write_summary(path: Path, gates: list[Gate], results: list[TrialResult], bill: dict[str, float]) -> None:
    summary = {
        "gates": [g.__dict__ | {"ok": g.ok} for g in gates],
        "trials": [asdict(r) for r in results],
        "tokens": bill,
    }
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
