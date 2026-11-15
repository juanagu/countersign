from pathlib import Path
from typing import Annotated, Any

import yaml
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.policy.risk_tier import RiskTier
from app.policy.tool_scopes import APPROVAL_ONLY_SCOPES, SCOPE_PATTERN

_FRONTMATTER = "---"


class Skill(BaseModel):
    """A domain skill: instructions the orchestrator loads on demand, plus the tools it unlocks."""

    model_config = ConfigDict(frozen=True)

    name: str = Field(pattern=r"^[a-z][a-z0-9_-]*$")
    description: str
    tools: frozenset[str]
    max_tier: RiskTier
    # Gateway scopes the skill's MCP tools need to be listed, never one only an approved call gets.
    scopes: frozenset[Annotated[str, StringConstraints(pattern=SCOPE_PATTERN)]] = frozenset()
    instructions: str

    @field_validator("scopes")
    @classmethod
    def _no_approval_only_scopes(cls, value: frozenset[str]) -> frozenset[str]:
        if refused := value & APPROVAL_ONLY_SCOPES:
            raise ValueError(f"approval-only scopes cannot be requested by a skill: {sorted(refused)}")
        return value

    @field_validator("max_tier", mode="before")
    @classmethod
    def _parse_tier(cls, value: object) -> RiskTier:
        tier = RiskTier.parse(value)
        if tier is None:
            raise ValueError(f"unknown risk tier {value!r}")
        return tier


def split_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """A skill file's YAML frontmatter and its stripped body."""
    if not text.startswith(_FRONTMATTER):
        raise ValueError("skill file must start with YAML frontmatter")
    _, frontmatter, body = text.split(_FRONTMATTER, 2)
    meta = yaml.safe_load(frontmatter)
    if not isinstance(meta, dict):
        raise ValueError("skill frontmatter must be a mapping")
    return meta, body.strip()


def parse_skill(text: str) -> Skill:
    meta, body = split_frontmatter(text)
    return Skill(**meta, instructions=body)


class SkillRegistry:
    def __init__(self, skills: list[Skill]):
        self._skills = {skill.name: skill for skill in skills}

    @classmethod
    def from_dir(cls, directory: Path) -> "SkillRegistry":
        return cls([parse_skill(path.read_text(encoding="utf-8")) for path in sorted(directory.glob("*.md"))])

    def get(self, name: str) -> Skill | None:
        return self._skills.get(name)

    def scopes_by_skill(self) -> dict[str, frozenset[str]]:
        """The gateway scopes each skill requests; a skill needs the gateway exactly when its set is non-empty."""
        return {name: skill.scopes for name, skill in self._skills.items()}

    def names(self) -> list[str]:
        return sorted(self._skills)

    def index(self) -> str:
        """The skill list the orchestrator sees before loading any."""
        lines = [f"- {s.name}: {s.description}" for s in self._skills.values()]
        return "Available skills (call load_skill before using their tools):\n" + "\n".join(lines)
