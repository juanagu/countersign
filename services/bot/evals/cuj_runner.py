"""`make cuj`: critical user journeys through the BFF, one gate table (`thresholds.yaml`), ADR 022.

Needs `make up`, `make seed` (the money journeys move Juan's ledger; `make cuj` re-seeds first, and each trial
starts from the balance read when the run began), `make ingest` and
ANTHROPIC_API_KEY. Trials run one at a time, because they share one ledger. Exits 1 when a gate is not met.
"""

import argparse
import asyncio
import os
import sys
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator
from pydantic_evals.reporting import EvaluationReport

from app.config import Settings
from evals.agui_client import BffSession, RunTrace, bff_client
from evals.bank_db import expire_draft, read_ledger, restore_balance
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
from evals.cuj_report import (
    TrialResult,
    cuj_gates,
    error_result,
    print_results,
    token_bill,
    trial_result,
    write_summary,
)
from evals.cuj_retry import RATE_LIMIT_RETRIES, rate_limit_stall, trace_gap_verdict
from evals.cuj_spans import Trial, emit_trials
from evals.cuj_user import Reply, Turn, is_end, simulated_user
from evals.delegation import CONFIRM_TEMPLATE
from evals.live import (
    OUT_OF_TURNS,
    STEP_UP_PIN,
    DiscardedAttempt,
    LiveInput,
    LiveOutput,
    Meta,
    Note,
    attach_delegated,
)
from evals.live_evaluators import Contains
from evals.run import print_gates
from evals.scenario_evaluators import NoRunErrors
from evals.thresholds import load_thresholds

WRONG_PIN = "000000"
CANCEL_PAYLOAD = {"approved": False, "reason": "El cliente canceló la transferencia."}  # As the web's Cancelar sends.

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
    inputs = LiveInput(user=scenario.user, turns=[scenario.opening])
    meta = {"group": scenario.group, "id": scenario.id, "driver": scenario.driver}
    return Case(name=scenario.id, inputs=inputs, metadata=meta, evaluators=tuple(evaluators_for(scenario)))


@dataclass
class Journey:
    """What a played journey left behind."""

    traces: list[RunTrace]
    notes: list[Note]
    turns: int


def _interrupted_draft(trace: RunTrace, interrupt: dict[str, Any]) -> str | None:
    """The draft an approval interrupt is for: its metadata when the bot sets one, else the `draft_id` argument of the
    paused call."""
    from_metadata = (interrupt.get("metadata") or {}).get("draft_id")
    if from_metadata:
        return str(from_metadata)
    ids = [e["toolCallId"] for e in trace.of("TOOL_CALL_START")]
    args = dict(zip(ids, (a for _, a in trace.tool_args), strict=True))
    draft = args.get(interrupt.get("toolCallId"), {}).get("draft_id")
    return str(draft) if draft else None


def _confirm_card(history: Sequence[RunTrace], trace: RunTrace, interrupt: dict[str, Any]) -> dict[str, Any] | None:
    """The interrupted draft's confirm card, looked up in every run of the session: the customer may have seen it a
    turn before the one that paused ("¿confirmás?" then "sí")."""
    draft = _interrupted_draft(trace, interrupt)
    cards = [
        c for t in history for c in t.cards if c.get("template") == CONFIRM_TEMPLATE and c["data"]["draftId"] == draft
    ]
    return cards[-1] if cards else None


async def answer_interrupt(
    session: BffSession, history: Sequence[RunTrace], trace: RunTrace, action: str
) -> tuple[RunTrace | None, str]:
    """Answers the run's pending approval as the customer's app would; `history` is every run so far, the paused one
    last. Returns the resume's trace, or a note."""
    interrupt = trace.interrupts[0]
    card = _confirm_card([*history, trace], trace, interrupt)
    if card is None:
        return None, f"no confirm card for the interrupted draft {_interrupted_draft(trace, interrupt)!r}"
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


async def follow_policy(
    session: BffSession, scenario: Scenario, history: Sequence[RunTrace], paused: RunTrace, notes: list[Note]
) -> list[RunTrace]:
    """The resume that answers a run's approval, per the scenario's `on_interrupt`; none when it has no policy."""
    action = scenario.on_interrupt.get(CONFIRM_TEMPLATE)
    if action is None:
        notes.append(Note("an interrupt the scenario has no on_interrupt policy for"))
        return []
    resumed, note = await answer_interrupt(session, history, paused, action)
    notes += [Note(note)] if note else []
    return [resumed] if resumed else []


async def play(session: BffSession, scenario: Scenario, reply: Reply | None) -> Journey:
    """Opening, then scripted turns or the simulated customer's, until the plan ends or `max_turns` runs out.

    Only the first approval follows the policy; a later one (a re-prepared draft) is left pending."""
    traces: list[RunTrace] = []
    notes: list[Note] = []
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
            runs += await follow_policy(session, scenario, traces, runs[0], notes)
        traces += runs
        conversation += [Turn("Cliente", message), Turn("Asistente", " ".join(t.text for t in runs if t.text))]
        message = await _next_message(scenario, scripted, reply, conversation)
    if message is not None:
        notes.append(Note(f"ran out of turns ({scenario.max_turns}) before the plan ended", OUT_OF_TURNS))
    return Journey(traces, notes, turns)


async def _next_message(scenario: Scenario, scripted: Any, reply: Reply | None, conversation: list[Turn]) -> str | None:
    if scenario.driver == "scripted":
        return next(scripted, None)
    assert reply is not None and scenario.plan is not None  # noqa: S101 - a simulated scenario always has both.
    message = await reply(scenario.plan, conversation)
    return None if is_end(message) else message


async def run_trial(scenario: Scenario, reply: Reply | None, starting: Mapping[str, Decimal]) -> LiveOutput:
    """One trial: the source account's balance restored, then the journey, run again on a fresh thread while the
    gateway's write limit stops it, and once when traces are missing and the visible part is clean (a second miss
    fails the trial). Every discarded attempt stays in the output with its verdict."""
    started = time.time_ns()
    discarded: list[DiscardedAttempt] = []
    reran_for_traces = False
    for attempt in range(1, RATE_LIMIT_RETRIES + 2):
        if scenario.source_account in starting:
            await restore_balance(scenario.source_account, starting[scenario.source_account])
        output = await run_attempt(scenario, reply)
        stall = rate_limit_stall(scenario, output)
        verdict, wait = (stall.verdict, stall.wait_seconds) if stall else (None, 0.0)
        if stall is None and not reran_for_traces and (verdict := trace_gap_verdict(scenario, output)):
            reran_for_traces = True
        if verdict is None or attempt > RATE_LIMIT_RETRIES:
            output.attempts, output.discarded = attempt, discarded
            output.start_ns, output.end_ns = started, time.time_ns()
            return output
        calls = [f"{c.name}:{c.outcome}" for c in output.calls]
        discarded.append(DiscardedAttempt(output.thread_id, verdict, calls))
        print(f"  {scenario.id}: {verdict}; waiting {wait:g}s", flush=True)
        await asyncio.sleep(wait)
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
    if scenario.handoffs or any(c.is_handoff for c in output.calls):
        await attach_delegated(output, session.thread_id, since)
    return output


async def run_scenario(
    scenario: Scenario, trials: int, reply: Reply | None, starting: Mapping[str, Decimal]
) -> list[TrialResult]:
    async def task(_: LiveInput) -> LiveOutput:
        return await run_trial(scenario, reply, starting)

    dataset = Dataset[LiveInput, LiveOutput, Meta](name=scenario.id, cases=[case_for(scenario)])
    report: Report = await dataset.evaluate(task, max_concurrency=1, progress=False, repeat=trials)
    results = [trial_result(case, n) for n, case in enumerate(report.cases, 1)]
    results += [error_result(scenario, len(results) + n, f.error_message) for n, f in enumerate(report.failures, 1)]
    return results


def _trial_span(r: TrialResult) -> Trial:
    discarded = tuple(a.thread_id for a in r.discarded)
    return Trial(
        cuj_id=r.cuj_id,
        trial=r.trial,
        passed=r.passed,
        turns=r.turns,
        driver=r.driver,
        thread_id=r.thread_id,
        policy_refused=r.policy_refused,
        start_ns=r.start_ns,
        end_ns=r.end_ns,
        discarded_threads=discarded,
    )


async def main(out: Path | None, only: str | None, trials: int | None) -> int:
    thresholds = load_thresholds()
    scenarios = [s for s in load_scenarios() if not only or only in s.id]
    if not scenarios:
        print(f"No journey matches {only!r}.")
        return 1
    settings = Settings()
    reply = simulated_user(settings.guard_model) if any(s.driver == "simulated" for s in scenarios) else None
    since = datetime.now(UTC)
    accounts = {s.source_account for s in scenarios}
    starting = {account: (await read_ledger(account)).balance for account in sorted(accounts)}
    results: list[TrialResult] = []
    for scenario in scenarios:
        results += await run_scenario(scenario, trials or scenario.trials, reply, starting)
    print_results(results)
    emit_trials([_trial_span(r) for r in results], os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"))
    gates = cuj_gates(results, thresholds)
    print_gates(gates)
    bill = token_bill(results, since)
    print(f"Tokens per journey (all trials): {bill}; total {sum(bill.values()):,.0f}")
    if out:
        write_summary(out, gates, results, bill)
    return 0 if gates and all(g.ok for g in gates) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="Write the gates and per-trial results as JSON here.")
    parser.add_argument("--only", help="Run only the journeys whose id contains this (a partial run still gates).")
    parser.add_argument("--trials", type=int, help="Override each journey's trials.")
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.out, args.only, args.trials)))
