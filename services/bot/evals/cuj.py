"""Critical user journeys (ADR 022): the scenario model and the loader for `cuj.yaml`.

A journey is one customer goal followed across turns until it ends, with the trajectory the bot must follow, the
calls it must never make and what the customer, the cards and the ledger must show afterwards.
"""

import re
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from evals.calls import ANY, CANCELLED, ERROR_PREFIX, PAUSED, RESULT

CUJ_PATH = Path(__file__).with_name("cuj.yaml")
DEFAULT_TRIALS = 3
OUTCOME = re.compile(rf"^({ANY}|{RESULT}|{PAUSED}|{CANCELLED}|{re.escape(ERROR_PREFIX)}[a-z_]+)$")
# What the client does when a run pauses on `execute_transfer`; code, never the simulated customer.
Action = Literal["approve", "cancel", "wrong_pin_then_approve", "expire_then_approve"]
SOURCE_ACCOUNTS = {"ana": "acc-ana-ars", "juan": "acc-juan-ars"}


def _check_rule_outcome(rule: str) -> None:
    """A `tool:outcome` rule names an outcome the trajectory can observe; a typo would match nothing and switch the
    check off."""
    _, _, outcome = rule.partition(":")
    if outcome and not OUTCOME.match(outcome):
        raise ValueError(f"rule {rule!r}: outcome {outcome!r} is not any, result, paused, cancelled or error:<code>")


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Step(Strict):
    tool: str
    outcome: str = RESULT
    args: dict[str, Any] = {}

    @field_validator("outcome")
    @classmethod
    def known_outcome(cls, value: str) -> str:
        if not OUTCOME.match(value):
            raise ValueError(f"outcome {value!r} is not any, result, paused, cancelled or error:<code>")
        return value


class Cards(Strict):
    present: list[str] = []
    absent: list[str] = []


JudgeName = Literal["quality", "citation"]  # The scenario evaluators' rubrics, scored as `judge_<name>`.


class Attack(Strict):
    """What a journey that replays an attack checks, as `redteam.yaml` does: the deterministic red-team checks (no
    write not asked for, no other customer's data, no credential request, no ungrounded figure, `must_not_contain`)
    and, when `judge` is set, a judge's verdict on whether the assistant complied with it."""

    must_not_contain: list[str] = []
    judge: str | None = None


class Expect(Strict):
    cards: Cards = Cards()
    attack: Attack | None = None
    final_turn_contains: list[str] = []  # In the last run's text or surfaces: the customer's last question worked.
    cites: list[str] = []  # A Citation surface names at least one of these document ids.
    grounded: bool = False  # Every figure the customer read is in a tool result.
    no_amounts: bool = False  # An honest "no tengo esa información" slips in no money figure.
    answers_in_text: bool = False  # The text answers; it never points at a card.
    spending_months: list[int] = []  # `spending_summary` was called for each month this many months back.
    spending_chart_each_turn: bool = False  # Each turn's BarChart bars are that turn's `spending_summary` totals.
    resumed_intact: bool = False  # `driver: reconnect`: the replay is the whole run, twice the same.
    text_contains: list[str] = []
    text_contains_any: list[str] = []
    ledger: Literal["none", "once"] | None = None  # No movement, or the draft's amount + fee debited exactly once.
    interrupts: int | None = None
    step_up_requests: int | None = None
    step_up_statuses: list[int] | None = None
    balance_read_matches_ledger: bool = False  # A balance tool's result shows the ledger's final balance.


class Scenario(Strict):
    id: str
    group: str  # The threshold it counts toward.
    rules: list[int] = []
    user: Literal["ana", "juan"]
    # reconnect: the opening's answer is cut mid-run, then the thread is reconnected twice (`expect.resumed_intact`).
    driver: Literal["scripted", "simulated", "reconnect"] = "scripted"
    opening: str
    then: list[str] = []  # Scripted: the turns after the opening.
    plan: str | None = None  # Simulated: what the customer wants, in the customer's voice.
    on_interrupt: dict[str, Action] = {}
    max_turns: int
    trials: int = DEFAULT_TRIALS
    trajectory: list[Step]
    allow: list[str] = []  # `tool` or `tool:outcome`: calls that may appear between steps without being listed.
    forbid: list[str] = []  # `tool` or `tool:outcome`; any matching call fails the trial.
    # "A <- B": a call matching A needs a call to B since the previous A (a retry must start from a fresh draft).
    requires: list[str] = []
    judges: list[JudgeName] = []  # Extra scores from the LLM judge on GUARD_MODEL; they never decide the trial.
    handoffs: list[str] = []  # Subagent domains the root must hand off to, read from the run's spans.
    expect: Expect = Expect()

    @model_validator(mode="after")
    def coherent(self) -> "Scenario":
        if self.driver == "simulated" and not self.plan:
            raise ValueError(f"{self.id}: a simulated journey needs a plan")
        if self.driver != "simulated" and 1 + len(self.then) > self.max_turns:
            raise ValueError(f"{self.id}: more scripted turns than max_turns")
        if self.driver == "reconnect" and self.then:
            raise ValueError(f"{self.id}: a reconnect journey has one turn")
        if self.expect.resumed_intact and self.driver != "reconnect":
            raise ValueError(f"{self.id}: resumed_intact needs driver: reconnect")
        return self

    @field_validator("allow", "forbid")
    @classmethod
    def known_rule_outcomes(cls, rules: list[str]) -> list[str]:
        for rule in rules:
            _check_rule_outcome(rule)
        return rules

    @field_validator("requires")
    @classmethod
    def well_formed_rules(cls, rules: list[str]) -> list[str]:
        for rule in rules:
            sides = rule.split(" <- ")
            if len(sides) != 2:
                raise ValueError(f"requires rule {rule!r} is not 'call <- earlier call'")
            for side in sides:
                _check_rule_outcome(side)
        return rules

    @property
    def customer_turns(self) -> list[str]:
        """The turns the customer's side is known to say up front (a simulated customer's later turns are not)."""
        return [self.opening, *self.then]

    @property
    def source_account(self) -> str:
        return SOURCE_ACCOUNTS[self.user]


def parse_scenarios(raw: str) -> list[Scenario]:
    scenarios = [Scenario.model_validate(entry) for entry in yaml.safe_load(raw) or []]
    ids = [s.id for s in scenarios]
    if len(ids) != len(set(ids)):
        raise ValueError(f"duplicate scenario ids: {sorted({i for i in ids if ids.count(i) > 1})}")
    return scenarios


def load_scenarios(path: Path = CUJ_PATH) -> list[Scenario]:
    return parse_scenarios(path.read_text(encoding="utf-8"))
