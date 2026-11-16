"""Evaluators for critical user journeys: the trajectory with an outcome per call, interrupts, cards, ledger and
step-up attempts. Each is deterministic; a journey passes a trial only when every one holds (ADR 022)."""

from dataclasses import dataclass, field
from decimal import Decimal

from pydantic_evals.evaluators import EvaluationReason, Evaluator

from app.subagents.registry import DELEGATE_PREFIX
from evals.bank_db import Ledger
from evals.calls import ANY, POLICY_DENIED, ObservedCall
from evals.cuj import Step
from evals.live import LiveInput, LiveOutput, Meta
from evals.live_evaluators import Ctx, reason_for, values_match
from evals.scenario_evaluators import MovedMoneyOnce

BALANCE_TOOLS = frozenset({"get_balance", "list_accounts"})


def _step_matches(step: Step, call: ObservedCall) -> bool:
    if step.tool != call.name or step.outcome not in (ANY, call.outcome):
        return False
    return all(values_match(v, call.args.get(k)) for k, v in step.args.items())


def rule_matches(rule: str, call: ObservedCall) -> bool:
    """`tool` matches the call whatever its outcome; `tool:outcome` only that outcome."""
    tool, _, outcome = rule.partition(":")
    return call.name == tool and (not outcome or outcome == call.outcome)


def _is_counted_refusal(call: ObservedCall, forbid: list[str]) -> bool:
    """A call the tool policy refused (the model attempted it, nothing ran) is counted by `LiveOutput.policy_refused`.
    A refused call is skipped by the trajectory, the steps and `requires` (it is never a draft, a pause or a
    result). Only a `forbid` rule that names `policy_denied` itself fails it, not a bare tool or another outcome."""
    explicit = [rule for rule in forbid if rule.partition(":")[2] == POLICY_DENIED]
    return call.outcome == POLICY_DENIED and not any(rule_matches(rule, call) for rule in explicit)


FORBIDDEN, UNEXPECTED, MISSING, UNMET = "forbidden", "unexpected", "missing", "unmet"


@dataclass(frozen=True)
class Problem:
    """One way a trajectory broke its rules: `kind`, the `call` ("name (outcome)", or the step's) and the `detail`."""

    kind: str
    call: str
    detail: str = ""

    @property
    def tool(self) -> str:
        return self.call.split(" ", 1)[0]

    def __str__(self) -> str:
        head = self.call if self.kind == UNMET else f"{self.kind} {self.call}"
        return f"{head} {self.detail}".strip()


def _label(call: ObservedCall) -> str:
    return f"{call.name} ({call.outcome})"


def _unmet_requirements(calls: list[ObservedCall], requires: list[str]) -> list[Problem]:
    """For each `A <- B` rule, the A calls with no B call since the previous A."""
    problems: list[Problem] = []
    for rule in requires:
        needing, _, needed = rule.partition(" <- ")
        fresh = False
        for call in calls:
            if call.outcome == POLICY_DENIED:
                continue
            if rule_matches(needed, call):
                fresh = True
            elif rule_matches(needing, call):
                if not fresh:
                    problems.append(Problem(UNMET, _label(call), f"without a new {needed} ({rule})"))
                fresh = False
    return problems


def trajectory_problems(
    calls: list[ObservedCall], steps: list[Step], allow: list[str], forbid: list[str], requires: list[str] | None = None
) -> list[Problem]:
    """Calls must follow `steps` in order. Others are fine only when listed in `allow`; a forbidden call fails even if
    it is also allowed. Steps never reached are missing. Policy-refused calls are counted elsewhere, see above."""
    problems: list[Problem] = []
    next_step = 0
    for call in calls:
        if _is_counted_refusal(call, forbid):
            continue
        if any(rule_matches(rule, call) for rule in forbid):
            problems.append(Problem(FORBIDDEN, _label(call)))
        elif next_step < len(steps) and _step_matches(steps[next_step], call):
            next_step += 1
        elif not any(rule_matches(rule, call) for rule in allow):
            problems.append(Problem(UNEXPECTED, _label(call), f"after {next_step} of {len(steps)} steps"))
    problems += [Problem(MISSING, f"{s.tool} ({s.outcome})") for s in steps[next_step:]]
    return problems + _unmet_requirements(calls, requires or [])


@dataclass
class Trajectory(Evaluator[LiveInput, LiveOutput, Meta]):
    steps: list[Step]
    allow: list[str]
    forbid: list[str]
    requires: list[str] = field(default_factory=list)

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        calls = ctx.output.calls
        problems = trajectory_problems(calls, self.steps, self.allow, self.forbid, self.requires)
        seen = [f"{c.name}:{c.outcome}" for c in calls]
        refused = f" Policy-refused attempts: {ctx.output.policy_refused}."
        return reason_for(not problems, f"{'; '.join(map(str, problems))}. Calls: {seen}.{refused}")


def visible_problems(
    calls: list[ObservedCall], steps: list[Step], allow: list[str], forbid: list[str]
) -> list[Problem]:
    """What can be judged without the missing traces: each observed call on its own, in any order. It fails when a
    `forbid` rule matches it, or when no step and no `allow` rule names it. Missing steps and `requires` need the
    whole trajectory, so they are not judged here. An unpaired call has unknown arguments, so a step's arguments never
    judge it: a step naming its tool accepts it."""
    problems: list[Problem] = []
    for call in calls:
        if _is_counted_refusal(call, forbid):
            continue
        if any(rule_matches(rule, call) for rule in forbid):
            problems.append(Problem(FORBIDDEN, _label(call)))
        elif call.unpaired and any(s.tool == call.name for s in steps):
            continue
        elif not any(_step_matches(s, call) for s in steps) and not any(rule_matches(r, call) for r in allow):
            problems.append(Problem(UNEXPECTED, _label(call)))
    return problems


@dataclass
class Handoffs(Evaluator[LiveInput, LiveOutput, Meta]):
    """The root handed off to these domains, read from the run's spans."""

    domains: list[str]

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        expected = {f"{DELEGATE_PREFIX}{d}" for d in self.domains}
        return reason_for(expected <= ctx.output.handoffs, f"handoffs {sorted(ctx.output.handoffs)}")


@dataclass
class Interrupts(Evaluator[LiveInput, LiveOutput, Meta]):
    count: int

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        raised = sum(len(trace.interrupts) for trace in ctx.output.traces)
        return reason_for(raised == self.count, f"{raised} interrupts, expected {self.count}")


@dataclass
class Cards(Evaluator[LiveInput, LiveOutput, Meta]):
    present: list[str]
    absent: list[str]

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        shown = {str(card.get("template")) for card in ctx.output.cards}
        missing, unexpected = set(self.present) - shown, set(self.absent) & shown
        return reason_for(not missing and not unexpected, f"cards {sorted(shown)}")


@dataclass
class ContainsAny(Evaluator[LiveInput, LiveOutput, Meta]):
    needles: list[str]

    def evaluate(self, ctx: Ctx) -> bool:
        shown = ctx.output.shown.lower()
        return any(needle.lower() in shown for needle in self.needles)


@dataclass
class LedgerDelta(Evaluator[LiveInput, LiveOutput, Meta]):
    """`none`: the source account's balance, transfers and sent movements are unchanged. `once`: see MovedMoneyOnce."""

    kind: str

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        change = ctx.output.ledger_change
        if self.kind == "once":
            return MovedMoneyOnce().evaluate(ctx)
        unchanged = change == Ledger(Decimal(0), 0, 0)
        return reason_for(unchanged, f"ledger change {change}")


@dataclass
class StepUpAttempts(Evaluator[LiveInput, LiveOutput, Meta]):
    """How many PINs were entered, and with what status each came back."""

    count: int | None
    statuses: list[int] | None

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        seen = ctx.output.step_up_statuses
        ok = (self.count is None or len(seen) == self.count) and (self.statuses is None or seen == self.statuses)
        return reason_for(ok, f"step-up statuses {seen}")


@dataclass
class BalanceMatchesLedger(Evaluator[LiveInput, LiveOutput, Meta]):
    """A balance tool's result, after the journey, shows the balance the ledger holds."""

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        after = ctx.output.ledger_after
        if after is None:
            return reason_for(False, "no ledger read after the journey")
        results = [content for tool in BALANCE_TOOLS for content in ctx.output.results_of(tool)]
        shown = [r for r in results if _has_amount(r, after.balance)]
        return reason_for(bool(shown), f"ledger balance {after.balance}; {len(results)} balance results read")


def _has_amount(content: str, amount: Decimal) -> bool:
    return f'"{amount:.2f}"' in content or f":{amount:.2f}" in content or f'"{amount}"' in content
