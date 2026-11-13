from pathlib import Path

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.policy.risk_tier import RiskTier

_FRONTMATTER = "---"


class Skill(BaseModel):
    """A domain skill: instructions the orchestrator loads on demand, plus the tools it unlocks."""

    model_config = ConfigDict(frozen=True)

    name: str = Field(pattern=r"^[a-z][a-z0-9_-]*$")
    description: str
    tools: frozenset[str]
    max_tier: RiskTier
    instructions: str

    @field_validator("max_tier", mode="before")
    @classmethod
    def _parse_tier(cls, value: object) -> RiskTier:
        tier = RiskTier.parse(value)
        if tier is None:
            raise ValueError(f"unknown risk tier {value!r}")
        return tier


def parse_skill(text: str) -> Skill:
    if not text.startswith(_FRONTMATTER):
        raise ValueError("skill file must start with YAML frontmatter")
    _, frontmatter, body = text.split(_FRONTMATTER, 2)
    meta = yaml.safe_load(frontmatter)
    return Skill(**meta, instructions=body.strip())


class SkillRegistry:
    def __init__(self, skills: list[Skill]):
        self._skills = {skill.name: skill for skill in skills}

    @classmethod
    def from_dir(cls, directory: Path) -> "SkillRegistry":
        return cls([parse_skill(path.read_text(encoding="utf-8")) for path in sorted(directory.glob("*.md"))])

    def get(self, name: str) -> Skill | None:
        return self._skills.get(name)

    def names(self) -> list[str]:
        return sorted(self._skills)

    def index(self) -> str:
        """The skill list the orchestrator sees before loading any."""
        lines = [f"- {s.name}: {s.description}" for s in self._skills.values()]
        return "Available skills (call load_skill before using their tools):\n" + "\n".join(lines)
