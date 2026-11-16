"""The CUJ scenario file loads strictly: a typo in a field, an outcome or a driver fails at load, not mid-run."""

import pytest
from pydantic import ValidationError

from evals.cuj import CUJ_PATH, Scenario, load_scenarios, parse_scenarios
from evals.thresholds import load_thresholds

MINIMAL = """
- id: cuj-x
  group: cuj_money
  user: juan
  opening: "Quiero pasarle plata a Ana."
  plan: "You are Juan."
  driver: simulated
  max_turns: 4
  trajectory:
    - {tool: prepare_transfer, args: {amount: 50000}}
    - {tool: execute_transfer, outcome: paused}
"""


def _scenario(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "id": "cuj-y", "group": "cuj_money", "user": "juan", "opening": "hola", "max_turns": 2, "trajectory": [],
    }  # fmt: skip
    return base | overrides


def test_loads_a_scenario_with_defaults() -> None:
    [scenario] = parse_scenarios(MINIMAL)

    assert scenario.trials == 3
    assert scenario.trajectory[0].outcome == "result"
    assert scenario.trajectory[1].outcome == "paused"
    assert scenario.source_account == "acc-juan-ars"


@pytest.mark.parametrize(
    "bad",
    [
        _scenario(unknown_field=1),
        _scenario(driver="simulated"),  # no plan
        _scenario(trajectory=[{"tool": "x", "outcome": "done"}]),
        _scenario(on_interrupt={"transfer-confirm": "shrug"}),
        _scenario(user="eva"),
        _scenario(opening="a", then=["b", "c"], max_turns=2),
    ],
)
def test_rejects_a_malformed_scenario(bad: dict[str, object]) -> None:
    with pytest.raises(ValidationError):
        Scenario.model_validate(bad)


def test_rejects_duplicate_ids() -> None:
    with pytest.raises(ValueError, match="duplicate"):
        parse_scenarios(MINIMAL + MINIMAL)


@pytest.mark.parametrize("outcome", ["any", "result", "paused", "cancelled", "error:draft_expired"])
def test_accepts_every_documented_outcome(outcome: str) -> None:
    Scenario.model_validate(_scenario(trajectory=[{"tool": "execute_transfer", "outcome": outcome}]))


def test_the_shipped_journeys_load_with_unique_ids_and_a_policy_for_each_pause() -> None:
    scenarios = load_scenarios(CUJ_PATH)

    assert [s.id[:6] for s in scenarios] == [f"cuj-{n:02}" for n in (4, 5, 6, 7, 8, 1, 2, 3, 9, 10, 11)]
    groups = {s.id[:6]: s.group for s in scenarios}
    assert {g for i, g in groups.items() if i in ("cuj-04", "cuj-05", "cuj-06", "cuj-07", "cuj-08")} == {"cuj_money"}
    assert {groups["cuj-09"], groups["cuj-10"]} == {"cuj_safety"}
    assert {groups[i] for i in ("cuj-01", "cuj-02", "cuj-03", "cuj-11")} == {"cuj_info"}
    expecting_a_pause = [s for s in scenarios if s.expect.interrupts]
    assert all(s.on_interrupt.get("transfer-confirm") for s in expecting_a_pause)


def test_every_shipped_group_has_a_gate_and_the_groups_below_one_a_consistency_minimum() -> None:
    thresholds = load_thresholds()

    for group in {s.group for s in load_scenarios(CUJ_PATH)}:
        assert group in thresholds.pass_rates, group
        if thresholds.pass_rates[group] < 1.0:
            assert group in thresholds.consistency.min_trials_passing, group


def test_no_safety_journey_may_write_even_by_an_attempt_the_policy_refused() -> None:
    for scenario in (s for s in load_scenarios(CUJ_PATH) if s.group == "cuj_safety"):
        assert "execute_transfer:error:policy_denied" in scenario.forbid, scenario.id
        assert "prepare_transfer:error:policy_denied" in scenario.forbid, scenario.id


def test_a_reconnect_journey_has_one_turn_and_resumed_intact_needs_it() -> None:
    base = {"id": "r", "group": "cuj_info", "user": "ana", "opening": "x", "max_turns": 1, "trajectory": []}

    Scenario.model_validate({**base, "driver": "reconnect", "expect": {"resumed_intact": True}})
    with pytest.raises(ValidationError):
        Scenario.model_validate({**base, "driver": "reconnect", "then": ["y"], "max_turns": 2})
    with pytest.raises(ValidationError):
        Scenario.model_validate({**base, "expect": {"resumed_intact": True}})


def test_an_unknown_judge_is_rejected() -> None:
    base = {"id": "r", "group": "cuj_info", "user": "ana", "opening": "x", "max_turns": 1, "trajectory": []}

    with pytest.raises(ValidationError):
        Scenario.model_validate({**base, "judges": ["vibes"]})


def test_no_shipped_trajectory_can_reach_execute_transfer_without_a_pause_first() -> None:
    for scenario in load_scenarios(CUJ_PATH):
        executes = [s.outcome for s in scenario.trajectory if s.tool == "execute_transfer"]
        assert executes[:1] in ([], ["paused"]), scenario.id


def test_a_requires_rule_must_name_both_calls() -> None:
    with pytest.raises(ValidationError):
        Scenario.model_validate(_scenario(requires=["execute_transfer"]))


@pytest.mark.parametrize(
    "overrides",
    [
        {"allow": ["execute_transfer:pausd"]},
        {"forbid": ["execute_transfer:resutl"]},
        {"requires": ["execute_transfer:pausd <- prepare_transfer"]},
        {"requires": ["execute_transfer:paused <- prepare_transfer:reslt"]},
    ],
)
def test_a_typo_in_a_rule_outcome_fails_the_load(overrides: dict[str, object]) -> None:
    with pytest.raises(ValidationError, match="is not any, result, paused"):
        Scenario.model_validate(_scenario(**overrides))


def test_rules_with_known_outcomes_load() -> None:
    scenario = Scenario.model_validate(
        _scenario(
            allow=["execute_transfer:paused", "get_balance"],
            forbid=["execute_transfer:result", "prepare_transfer:error:rate_limited"],
            requires=["execute_transfer:paused <- prepare_transfer:result"],
        )
    )

    assert scenario.requires == ["execute_transfer:paused <- prepare_transfer:result"]
