"""The evaluators a journey's scenario file asks for, and the pydantic-evals case that carries them (ADR 022)."""

from datetime import date

from pydantic_evals import Case
from pydantic_evals.evaluators import Evaluator

from evals.cuj import Scenario
from evals.cuj_content_evaluators import AttackNotObeyed, FinalTurnContains, RedTeamChecks, SpendingChartEachTurn
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
from evals.golden import month_range
from evals.live import SPENDING_TOOL, LiveInput, LiveOutput, Meta
from evals.live_evaluators import AnswersInText, CalledTool, Cites, Contains, Grounded, NoAmounts
from evals.redteam import Suite
from evals.scenario_evaluators import CITATION_RUBRIC, QUALITY_RUBRIC, Judge, NoRunErrors, ResumedIntact

CujEvaluator = Evaluator[LiveInput, LiveOutput, Meta]


JUDGE_RUBRICS = {"quality": QUALITY_RUBRIC, "citation": CITATION_RUBRIC}


def _content_checks(scenario: Scenario, today: date) -> list[CujEvaluator]:
    expect = scenario.expect
    checks: list[CujEvaluator] = [Contains(text) for text in expect.text_contains]
    checks += [Cites(tuple(expect.cites))] if expect.cites else []
    checks += [Grounded()] if expect.grounded else []
    checks += [NoAmounts()] if expect.no_amounts else []
    checks += [AnswersInText()] if expect.answers_in_text else []
    checks += [FinalTurnContains(expect.final_turn_contains)] if expect.final_turn_contains else []
    for months_back in expect.spending_months:
        first, last = month_range(today, months_back)
        checks.append(CalledTool(SPENDING_TOOL, {"from": first.isoformat(), "to": last.isoformat()}))
    checks += [SpendingChartEachTurn(len(expect.spending_months) or 1)] if expect.spending_chart_each_turn else []
    checks += [ResumedIntact()] if expect.resumed_intact else []
    return checks


def _attack_checks(scenario: Scenario, judge_model: str, suite: Suite) -> list[CujEvaluator]:
    attack = scenario.expect.attack
    if attack is None:
        return []
    deterministic = RedTeamChecks(suite, scenario.user, attack.must_not_contain)
    return (
        [deterministic, AttackNotObeyed(attack.judge, judge_model, deterministic)] if attack.judge else [deterministic]
    )


def evaluators_for(scenario: Scenario, judge_model: str, suite: Suite, today: date) -> list[CujEvaluator]:
    expect = scenario.expect
    checks: list[CujEvaluator] = [
        NoRunErrors(),
        Trajectory(scenario.trajectory, scenario.allow, scenario.forbid, scenario.requires),
        Cards(expect.cards.present, expect.cards.absent),
        *_content_checks(scenario, today),
        *_attack_checks(scenario, judge_model, suite),
        *(Judge(f"judge_{name}", JUDGE_RUBRICS[name], judge_model) for name in scenario.judges),
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


def case_for(scenario: Scenario, judge_model: str, suite: Suite, today: date) -> Case[LiveInput, LiveOutput, Meta]:
    inputs = LiveInput(user=scenario.user, turns=scenario.customer_turns)
    meta = {"group": scenario.group, "id": scenario.id, "driver": scenario.driver}
    evaluators = tuple(evaluators_for(scenario, judge_model, suite, today))
    return Case(name=scenario.id, inputs=inputs, metadata=meta, evaluators=evaluators)
