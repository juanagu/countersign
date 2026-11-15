"""`make cuj`: critical user journeys through the BFF, one gate table (`thresholds.yaml`), ADR 022.

Needs `make up`, `make seed` (the money journeys move Juan's ledger; `make cuj` re-seeds first), `make ingest` and
ANTHROPIC_API_KEY. Trials run one at a time, because they share one ledger. Exits 1 when a gate is not met.
"""

import argparse
import asyncio
import json
import os
import sys
import time
from collections import defaultdict
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx
from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator
from pydantic_evals.reporting import EvaluationReport, ReportCase

from app.config import Settings
from evals.agui_client import BffSession, RunTrace, bff_client
from evals.bank_db import expire_draft, read_ledger
from evals.cuj import Scenario, load_scenarios
from evals.cuj_evaluators import (
    BalanceMatchesLedger,
    Cards,
    ContainsAny,
    Handoffs,
    Interrupts,
    LedgerDelta,
    StepUpAttempts,
    Trajectory,
)
from evals.cuj_spans import NANOS, Trial, emit_trials
from evals.cuj_user import Reply, Turn, is_end, simulated_user
from evals.delegation import read_delegated
from evals.live import STEP_UP_PIN, LiveInput, LiveOutput, Meta
from evals.live_evaluators import Contains
from evals.metrics import spans, tokens_by_thread
from evals.run import Gate, print_gates
from evals.scenario_evaluators import NoRunErrors
from evals.thresholds import Thresholds, load_thresholds

CONFIRM_TEMPLATE = "transfer-confirm"
WRONG_PIN = "000000"
CANCEL_PAYLOAD = {"approved": False, "reason": "El cliente canceló la transferencia."}  # As the web's Cancelar sends.
HANDOFF_PREFIX = "ask_"
# The gateway allows each customer 20 reversible writes per 10 minutes (ADR 017), and every trial prepares at least
# one. A trial refused for that reason says nothing about the bot, so it waits for the window and runs again.
RATE_LIMITED = "error:rate_limited"
RATE_LIMIT_WAIT_SECONDS = 60.0
RATE_LIMIT_RETRIES = 12

CujEvaluator = Evaluator[LiveInput, LiveOutput, Meta]
Report = EvaluationReport[LiveInput, LiveOutput, Meta]


def evaluators_for(scenario: Scenario) -> list[CujEvaluator]:
    expect = scenario.expect
    checks: list[CujEvaluator] = [
        NoRunErrors(),
        Trajectory(scenario.trajectory, scenario.allow, scenario.forbid, scenario.requires),
        Cards(expect.cards.present, expect.cards.absent),
        *(Contains(text) for text in expect.text_contains),
    ]
    if scenario.handoffs:
        checks.append(Handoffs(scenario.handoffs))
    if expect.text_contains_any:
        checks.append(ContainsAny(expect.text_contains_any))
    if expect.ledger:
        checks.append(LedgerDelta(expect.ledger))
    if expect.interrupts is not None:
        checks.append(Interrupts(expect.interrupts))
    if expect.step_up_requests is not None or expect.step_up_statuses is not None:
        checks.append(StepUpAttempts(expect.step_up_requests, expect.step_up_statuses))
    if expect.balance_read_matches_ledger:
        checks.append(BalanceMatchesLedger())
    return checks


def case_for(scenario: Scenario) -> Case[LiveInput, LiveOutput, Meta]:
    inputs = LiveInput(user=scenario.user, turns=[scenario.opening], scenario_id=scenario.id)
    meta = {"group": scenario.group, "id": scenario.id, "driver": scenario.driver}
    return Case(name=scenario.id, inputs=inputs, metadata=meta, evaluators=tuple(evaluators_for(scenario)))


@dataclass
class Journey:
    """What a played journey left behind."""

    traces: list[RunTrace]
    notes: list[str]
    turns: int


def _confirm_card(trace: RunTrace) -> dict[str, Any] | None:
    cards = [c for c in trace.cards if c.get("template") == CONFIRM_TEMPLATE]
    return cards[-1] if cards else None


async def answer_interrupt(session: BffSession, trace: RunTrace, action: str) -> tuple[RunTrace | None, str]:
    """Answers the run's pending approval as the customer's app would. Returns the resume's trace, or a note."""
    card = _confirm_card(trace)
    if card is None:
        return None, "interrupt without a confirm card"
    interrupt = trace.interrupts[0]
    if action == "cancel":
        return await session.resume(interrupt, CANCEL_PAYLOAD), ""
    if action == "expire_then_approve":
        await expire_draft(card["data"]["draftId"])
    if action == "wrong_pin_then_approve":
        await session.try_step_up(card, WRONG_PIN)
    attempt = await session.try_step_up(card, STEP_UP_PIN)
    if attempt.token is None:
        return None, f"step-up refused with the right PIN: {attempt.status} {attempt.body}"
    edited = {"draft_id": card["data"]["draftId"], "step_up_token": attempt.token}
    return await session.resume(interrupt, {"approved": True, "editedArgs": edited}), ""


async def follow_policy(session: BffSession, scenario: Scenario, paused: RunTrace, notes: list[str]) -> list[RunTrace]:
    """The resume that answers a run's approval, per the scenario's `on_interrupt`; none when it has no policy."""
    action = scenario.on_interrupt.get(CONFIRM_TEMPLATE)
    if action is None:
        notes.append("an interrupt the scenario has no on_interrupt policy for")
        return []
    resumed, note = await answer_interrupt(session, paused, action)
    notes += [note] if note else []
    return [resumed] if resumed else []


async def play(session: BffSession, scenario: Scenario, reply: Reply | None) -> Journey:
    """Opening, then scripted turns or the simulated customer's, until the plan ends or `max_turns` runs out.

    Only the first approval follows the policy; a later one (a re-prepared draft) is left pending."""
    traces: list[RunTrace] = []
    notes: list[str] = []
    conversation: list[Turn] = []
    scripted = iter(scenario.then)
    message: str | None = scenario.opening
    answered = False
    turns = 0
    while message is not None and turns < scenario.max_turns:
        turns += 1
        runs = [await session.say(message)]
        if runs[0].interrupted and not answered:
            answered = True
            runs += await follow_policy(session, scenario, runs[0], notes)
        traces += runs
        conversation += [Turn("Cliente", message), Turn("Asistente", " ".join(t.text for t in runs if t.text))]
        message = await _next_message(scenario, scripted, reply, conversation)
    if message is not None:
        notes.append(f"ran out of turns ({scenario.max_turns}) before the plan ended")
    return Journey(traces, notes, turns)


async def _next_message(scenario: Scenario, scripted: Any, reply: Reply | None, conversation: list[Turn]) -> str | None:
    if scenario.driver == "scripted":
        return next(scripted, None)
    assert reply is not None and scenario.plan is not None  # noqa: S101 - a simulated scenario always has both.
    message = await reply(scenario.plan, conversation)
    return None if is_end(message) else message


async def run_trial(scenario: Scenario, reply: Reply | None) -> LiveOutput:
    """One trial, run again (fresh session and thread) while the gateway's write limit refuses its writes."""
    for attempt in range(1, RATE_LIMIT_RETRIES + 2):
        output = await run_attempt(scenario, reply)
        output.attempts = attempt
        if attempt > RATE_LIMIT_RETRIES or not any(c.outcome == RATE_LIMITED for c in output.calls):
            return output
        print(
            f"  {scenario.id}: the gateway's write limit refused it; waiting {RATE_LIMIT_WAIT_SECONDS:g}s", flush=True
        )
        await asyncio.sleep(RATE_LIMIT_WAIT_SECONDS)
    raise AssertionError("unreachable")  # pragma: no cover


async def run_attempt(scenario: Scenario, reply: Reply | None) -> LiveOutput:
    since = datetime.now(UTC)
    account = scenario.source_account
    async with bff_client() as http:
        session = await BffSession.login(http, scenario.user)
        before = await read_ledger(account)
        journey = await play(session, scenario, reply)
        after = await read_ledger(account)
    output = LiveOutput(
        journey.traces,
        ledger_change=after.minus(before),
        ledger_after=after,
        notes=journey.notes,
        step_up_statuses=session.step_up_statuses,
        thread_id=session.thread_id,
        turns=journey.turns,
    )
    if scenario.handoffs or any(c.name.startswith(HANDOFF_PREFIX) for c in output.calls):
        delegated = await read_delegated(session.thread_id, since, output.cards, runs=len(output.traces))
        output.delegated = delegated or []
        output.notes += [] if delegated is not None else ["no trace for the thread in Phoenix"]
    return output


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


def trial_result(case: ReportCase[LiveInput, LiveOutput, Meta], trial: int) -> TrialResult:
    meta = case.metadata or {}
    failed = {name: a.reason for name, a in case.assertions.items() if not a.value}
    failed |= {f.name: f.error_message for f in case.evaluator_failures}
    now = time.time_ns()
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
        start_ns=now - int(case.total_duration * NANOS),
        end_ns=now,
    )


def error_result(scenario: Scenario, trial: int, message: str) -> TrialResult:
    now = time.time_ns()
    return TrialResult(
        scenario.id, scenario.group, trial, False, {"task": message}, 0.0, 0, "", "", [], scenario.driver, 1, now, now
    )


async def run_scenario(scenario: Scenario, trials: int, reply: Reply | None) -> list[TrialResult]:
    async def task(_: LiveInput) -> LiveOutput:
        return await run_trial(scenario, reply)

    dataset = Dataset[LiveInput, LiveOutput, Meta](name=scenario.id, cases=[case_for(scenario)])
    report: Report = await dataset.evaluate(task, max_concurrency=1, progress=False, repeat=trials)
    results = [trial_result(case, n) for n, case in enumerate(report.cases, 1)]
    results += [error_result(scenario, len(results) + n, f.error_message) for n, f in enumerate(report.failures, 1)]
    return results


def cuj_gates(results: list[TrialResult], thresholds: Thresholds) -> list[Gate]:
    """Per group: the share of trials that passed, and, where the group allows misses, each journey's passing trials."""
    gates: list[Gate] = []
    for group in sorted({r.group for r in results}):
        trials = [r for r in results if r.group == group]
        passed = sum(r.passed for r in trials)
        if group in thresholds.pass_rates:
            detail = f"{passed}/{len(trials)} trials"
            gates.append(Gate(group, passed / len(trials), thresholds.pass_rates[group], detail))
        minimum = thresholds.consistency.min_trials_passing.get(group)
        if minimum is not None:
            per_journey: dict[str, int] = defaultdict(int)
            for r in trials:
                per_journey[r.cuj_id] += r.passed
            detail = f"passing trials per journey {dict(per_journey)}"
            gates.append(Gate(f"{group} consistency", float(min(per_journey.values())), float(minimum), detail))
    return gates


def print_results(results: list[TrialResult]) -> None:
    for r in results:
        mark = "PASS" if r.passed else "FAIL"
        retried = f", {r.attempts} attempts" if r.attempts > 1 else ""
        print(f"{mark} {r.cuj_id} trial {r.trial} ({r.seconds}s, {r.turns} turns{retried}) calls: {r.calls}")
        for name, reason in r.failed.items():
            print(f"     failed {name}: {reason}")


def token_bill(results: list[TrialResult], since: datetime) -> dict[str, float]:
    """Tokens per journey id (orchestrator, subagent and guard models together) from Phoenix; empty without it."""
    try:
        stream = list(spans(since, name="bot.stream"))
        models = list(spans(since, span_kind="LLM"))
    except httpx.HTTPError:
        return {}
    by_thread = tokens_by_thread(stream, models)
    bill: dict[str, float] = defaultdict(float)
    for r in results:
        bill[r.cuj_id] += by_thread.get(r.thread_id, 0.0)
    return dict(bill)


def write_summary(path: Path, gates: list[Gate], results: list[TrialResult], bill: dict[str, float]) -> None:
    summary = {
        "gates": [g.__dict__ | {"ok": g.ok} for g in gates],
        "trials": [r.__dict__ for r in results],
        "tokens": bill,
    }
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


async def main(out: Path | None, only: str | None, trials: int | None) -> int:
    thresholds = load_thresholds()
    scenarios = [s for s in load_scenarios() if not only or only in s.id]
    if not scenarios:
        print(f"No journey matches {only!r}.")
        return 1
    settings = Settings()
    reply = simulated_user(settings.guard_model) if any(s.driver == "simulated" for s in scenarios) else None
    since = datetime.now(UTC)
    results: list[TrialResult] = []
    for scenario in scenarios:
        results += await run_scenario(scenario, trials or scenario.trials, reply)
    print_results(results)
    emit_trials(
        [Trial(r.cuj_id, r.trial, r.passed, r.turns, r.driver, r.thread_id, r.start_ns, r.end_ns) for r in results],
        os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"),
    )
    gates = cuj_gates(results, thresholds)
    print_gates(gates)
    bill = token_bill(results, since)
    print(f"Tokens per journey (all trials): {bill}; total {sum(bill.values()):,.0f}")
    if out:
        write_summary(out, gates, results, bill)
    return 0 if all(g.ok for g in gates) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="Write the gates and per-trial results as JSON here.")
    parser.add_argument("--only", help="Run only the journeys whose id contains this (a partial run still gates).")
    parser.add_argument("--trials", type=int, help="Override each journey's trials.")
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.out, args.only, args.trials)))
