"""When a CUJ attempt is worth running again: only when the gateway's write limit is the sole reason it fell short.

The whole attempt is judged, every call counted, the rate-limited ones too: an attempted forbidden call is a violation
whether or not the gateway let it through (ADR 022)."""

from dataclasses import dataclass

from evals.calls import ObservedCall
from evals.cuj import Scenario
from evals.cuj_evaluators import MISSING, UNEXPECTED, Problem, trajectory_problems
from evals.live import LiveOutput

# The gateway allows each customer 20 reversible writes per 10 minutes (ADR 017), and every trial prepares at least
# one. A trial that was going right until the gateway refused a write says nothing about the bot, so it waits for the
# gateway's `retry_after_seconds` (never longer than the window) and runs again.
RATE_LIMITED = "error:rate_limited"
RATE_LIMIT_WINDOW_SECONDS = 600.0
RATE_LIMIT_WAIT_SECONDS = 60.0  # When the refusal names no `retry_after_seconds`.
RATE_LIMIT_RETRIES = 12


@dataclass(frozen=True)
class Stall:
    """An attempt the gateway's write limit stopped, with nothing else wrong."""

    verdict: str
    wait_seconds: float


def _tools_the_journey_names(scenario: Scenario) -> set[str]:
    rules = [*scenario.allow, *(s.tool for s in scenario.trajectory)]
    return {rule.partition(":")[0] for rule in rules}


def _attempted_a_forbidden_tool(scenario: Scenario, refusals: list[ObservedCall]) -> bool:
    """A refused call never had an outcome of its own, so a `forbid` rule matches it by tool, whatever the outcome."""
    forbidden = {rule.partition(":")[0] for rule in scenario.forbid}
    return any(c.name in forbidden for c in refusals)


def rate_limit_stall(scenario: Scenario, output: LiveOutput) -> Stall | None:
    """The whole attempt, judged first. It is a stall only when a `rate_limited` refusal is there, no run errored, no
    call (a refused one included) broke `forbid`, `allow` or `requires`, and the only problems are steps never
    reached. A refused call the journey names is not itself unexpected: it is the refusal."""
    calls = output.calls
    refusals = [c for c in calls if c.outcome == RATE_LIMITED]
    if not refusals or output.errors or _attempted_a_forbidden_tool(scenario, refusals):
        return None
    named = _tools_the_journey_names(scenario)
    problems = trajectory_problems(calls, scenario.trajectory, scenario.allow, scenario.forbid, scenario.requires)
    if not problems or any(not _is_stall_effect(p, refusals, named) for p in problems):
        return None
    first = calls.index(refusals[0])
    return Stall(f"rate limited at {refusals[0].name} after {first} calls", _wait_seconds(refusals))


def _is_stall_effect(problem: Problem, refusals: list[ObservedCall], named: set[str]) -> bool:
    if problem.kind == MISSING:
        return True
    refused = {f"{c.name} ({c.outcome})" for c in refusals if c.name in named}
    return problem.kind == UNEXPECTED and problem.call in refused


def _wait_seconds(refusals: list[ObservedCall]) -> float:
    named = [c.retry_after_seconds for c in refusals if c.retry_after_seconds is not None]
    return min(float(max(named)), RATE_LIMIT_WINDOW_SECONDS) if named else RATE_LIMIT_WAIT_SECONDS
