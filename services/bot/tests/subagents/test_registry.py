"""Subagent specs (ADR 021): a skill's frontmatter, a T2 ceiling, and no name shared with a skill (rule 2)."""

from pathlib import Path

import pytest
from pydantic import ValidationError

from app.policy.risk_tier import RiskTier
from app.skills.registry import SkillRegistry, parse_skill
from app.subagents.registry import SubagentRegistry, parse_subagent

_SPEC = (
    "---\nname: {name}\ndescription: d\ntools: [list_beneficiaries, prepare_transfer]\n"
    "max_tier: {tier}\n{extra}---\nbody"
)
_SKILLS = SkillRegistry([parse_skill(_SPEC.format(name="accounts", tier="T1", extra=""))])


def _write(directory: Path, name: str, tier: str = "T2", extra: str = "") -> None:
    (directory / f"{name}.md").write_text(_SPEC.format(name=name, tier=tier, extra=extra), encoding="utf-8")


def test_loads_a_subagent_dir_with_its_scopes_and_index(tmp_path: Path) -> None:
    _write(tmp_path, "payments", extra="scopes: [beneficiaries:read, transfers:prepare]\n")
    registry = SubagentRegistry.from_dir(tmp_path, skills=_SKILLS)

    spec = registry.get("payments")
    assert spec is not None and spec.max_tier is RiskTier.T2 and spec.instructions == "body"
    assert registry.scopes_by_skill() == {"payments": frozenset({"beneficiaries:read", "transfers:prepare"})}
    assert "ask_payments: d" in (registry.index() or "")


def test_no_dir_means_no_subagent(tmp_path: Path) -> None:
    registry = SubagentRegistry.from_dir(tmp_path / "missing", skills=_SKILLS)
    assert registry.names() == [] and registry.index() is None


def test_a_subagent_above_t2_fails_to_load(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="subagents stop at T2"):
        parse_subagent(_SPEC.format(name="payments", tier="T3", extra=""))
    _write(tmp_path, "payments", tier="T3")
    with pytest.raises(ValueError, match="subagents stop at T2"):
        SubagentRegistry.from_dir(tmp_path, skills=_SKILLS)


def test_a_spec_built_in_code_above_t2_is_refused_too() -> None:
    spec = parse_skill(_SPEC.format(name="payments", tier="T3", extra=""))
    with pytest.raises(ValueError, match="subagents stop at T2"):
        SubagentRegistry([spec], skills=_SKILLS)


def test_a_subagent_requesting_an_approval_only_scope_fails_to_load() -> None:
    with pytest.raises(ValidationError, match="approval-only"):
        parse_subagent(_SPEC.format(name="payments", tier="T2", extra="scopes: [transfers:execute]\n"))


def test_a_subagent_named_like_a_skill_fails_to_load(tmp_path: Path) -> None:
    _write(tmp_path, "accounts", tier="T1")
    with pytest.raises(ValueError, match="name of a skill"):
        SubagentRegistry.from_dir(tmp_path, skills=_SKILLS)


def test_two_subagents_with_one_name_fail_to_load() -> None:
    spec = parse_subagent(_SPEC.format(name="payments", tier="T2", extra=""))
    with pytest.raises(ValueError, match="defined twice"):
        SubagentRegistry([spec, spec], skills=_SKILLS)
