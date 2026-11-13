"""The eval gates, kept in `thresholds.yaml` so they change in config, not in code."""

from pathlib import Path

import yaml
from pydantic import BaseModel

THRESHOLDS = Path(__file__).with_name("thresholds.yaml")


class Thresholds(BaseModel):
    pass_rates: dict[str, float]
    judge_averages: dict[str, float]


def load_thresholds(path: Path = THRESHOLDS) -> Thresholds:
    return Thresholds.model_validate(yaml.safe_load(path.read_text(encoding="utf-8")))
