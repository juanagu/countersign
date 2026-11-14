"""The eval gates, kept in `thresholds.yaml` so they change in config, not in code."""

from pathlib import Path

import yaml
from pydantic import BaseModel

THRESHOLDS = Path(__file__).with_name("thresholds.yaml")


class GateOverrides(BaseModel):
    pass_rates: dict[str, float] = {}
    judge_averages: dict[str, float] = {}


class Thresholds(BaseModel):
    pass_rates: dict[str, float]
    judge_averages: dict[str, float]
    backup_mode: GateOverrides = GateOverrides()

    def for_backup(self) -> "Thresholds":
        """The gates `make eval-backup` applies: these, with `backup_mode`'s values replacing theirs."""
        return Thresholds(
            pass_rates=self.pass_rates | self.backup_mode.pass_rates,
            judge_averages=self.judge_averages | self.backup_mode.judge_averages,
        )


def load_thresholds(path: Path = THRESHOLDS) -> Thresholds:
    return Thresholds.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))
