"""Subagent specs: a skill's frontmatter, a T2 ceiling, and no name shared with a skill (rule 2)."""

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
    _write(tmp_path, "payments", tier="T3")
    with pytest.raises(ValueError, match="subagents stop at T2"):
        SubagentRegistry.from_dir(tmp_path, skills=_SKILLS)


def test_a_spec_built_in_code_above_t2_is_refused_too() -> None:
    spec = parse_subagent(_SPEC.format(name="payments", tier="T3", extra=""))
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


_TRANSFERS = parse_skill("---\nname: transfers\ndescription: d\ntools: [execute_transfer]\nmax_tier: T3\n---\nbody")
_WITH_TRANSFERS = SkillRegistry([_TRANSFERS, *(s for s in [_SKILLS.get("accounts")] if s)])


def _handing_off(tool: str, skill: str) -> str:
    return _SPEC.format(name="payments", tier="T2", extra=f"hands_off: {{tool: {tool}, skill: {skill}}}\n")


def test_a_hand_off_to_a_skill_that_grants_the_t3_call_loads_and_without_one_there_is_none() -> None:
    registry = SubagentRegistry([parse_subagent(_handing_off("prepare_transfer", "transfers"))], skills=_WITH_TRANSFERS)
    spec = registry.get("payments")
    assert spec is not None and spec.hands_off is not None
    assert (spec.hands_off.tool, spec.hands_off.skill) == ("prepare_transfer", "transfers")
    assert "the transfers skill" in (registry.index() or "")
    plain = SubagentRegistry([parse_subagent(_SPEC.format(name="payments", tier="T2", extra=""))], skills=_SKILLS)
    spec = plain.get("payments")
    assert spec is not None and spec.hands_off is None and "draft_id" not in (plain.index() or "")


@pytest.mark.parametrize(
    ("tool", "skill", "error"),
    [
        ("prepare_transfer", "loans", "which is not a skill"),
        ("execute_transfer", "transfers", "which it does not have"),
        ("prepare_transfer", "accounts", "grants no T3 call"),
    ],
    ids=["missing-skill", "tool-not-its-own", "skill-without-t3"],
)
def test_a_hand_off_that_names_a_missing_skill_or_tool_fails_to_load(
    tmp_path: Path, tool: str, skill: str, error: str
) -> None:
    (tmp_path / "payments.md").write_text(_handing_off(tool, skill), encoding="utf-8")
    with pytest.raises(ValueError, match=error):
        SubagentRegistry.from_dir(tmp_path, skills=_WITH_TRANSFERS)


def test_the_shipped_payments_subagent_prepares_and_the_transfers_skill_alone_executes() -> None:
    from app.config import SKILLS_DIR, SUBAGENTS_DIR

    skills = SkillRegistry.from_dir(SKILLS_DIR)
    registry = SubagentRegistry.from_dir(SUBAGENTS_DIR, skills=skills)
    payments, transfers = registry.get("payments"), skills.get("transfers")
    assert registry.names() == ["payments"] and payments is not None and transfers is not None
    assert payments.max_tier is RiskTier.T2 and "execute_transfer" not in payments.tools
    assert payments.hands_off is not None
    assert (payments.hands_off.tool, payments.hands_off.skill) == ("prepare_transfer", "transfers")
    assert payments.scopes == frozenset({"accounts:read", "beneficiaries:read", "transfers:prepare"})
    assert transfers.tools == frozenset({"execute_transfer"}) and transfers.max_tier is RiskTier.T3
    assert transfers.scopes == frozenset({"transfers:prepare"})  # The list scope execute_transfer needs.


def test_the_app_builds_its_agents_from_the_shipped_skills_and_subagents() -> None:
    from app.config import Settings
    from app.core.llm.model_chain import ModelChains
    from app.main import create_app
    from tests.conftest import TEST_CLIENT_SECRET

    secret = TEST_CLIENT_SECRET
    no_fallbacks = {"bot_model_fallbacks": "", "guard_model_fallbacks": ""}
    settings = Settings(bot_model="test", guard_model="test", bot_client_secret=secret, **no_fallbacks)
    create_app(settings)  # A name clash or a spec above T2 would fail here, at startup.
    chains = ModelChains.from_settings(settings, subagents=["payments"])
    assert chains.subagents["payments"].role == "payments"
    assert settings.subagent_models("payments") == ("test",)  # Empty: the orchestrator's models.
    own = settings.model_copy(update={"payments_agent_model": "test", "payments_agent_model_fallbacks": "a, b"})
    assert own.subagent_models("payments") == ("test", "a", "b")


def test_a_subagent_without_model_settings_of_its_own_fails_at_startup(tmp_path: Path) -> None:
    from app.main import create_app
    from tests.conftest import make_settings

    skills, subagents = tmp_path / "skills", tmp_path / "subagents"
    skills.mkdir()
    subagents.mkdir()
    spec = "---\nname: loans\ndescription: Loans.\ntools: [list_accounts]\nmax_tier: T1\n---\nloans body"
    (subagents / "loans.md").write_text(spec, encoding="utf-8")
    settings = make_settings().model_copy(update={"skills_dir": skills, "subagents_dir": subagents})

    with pytest.raises(ValueError, match="loans_agent_model"):
        create_app(settings)
    with pytest.raises(ValueError, match="loans_agent_model"):
        settings.subagent_models("loans")
