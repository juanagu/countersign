"""The CUJ scenario file loads strictly: a typo in a field, an outcome or a driver fails at load, not mid-run."""

import pytest
from pydantic import ValidationError

from evals.cuj import Scenario, parse_scenarios

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
