import pytest
from pydantic import ValidationError

from app.config import SKILLS_DIR
from app.policy.risk_tier import RiskTier
from app.skills.registry import SkillRegistry, parse_skill

_SKILL = "---\nname: x\ndescription: d\ntools: [a]\nmax_tier: T1\n{extra}---\nbody"


def test_loads_the_shipped_skills() -> None:
    registry = SkillRegistry.from_dir(SKILLS_DIR)
    assert registry.names() == ["accounts", "knowledge", "payments"]
    accounts = registry.get("accounts")
    assert accounts is not None
    assert accounts.max_tier is RiskTier.T1
    assert "spending_summary" in accounts.tools
    assert "load_skill" in registry.index()


def test_maps_each_shipped_skill_to_the_gateway_scopes_it_requests() -> None:
    assert SkillRegistry.from_dir(SKILLS_DIR).scopes_by_skill() == {
        "accounts": frozenset({"accounts:read"}),
        # Payments also reads accounts, and never asks for transfers:execute: only an approved call gets that.
        "payments": frozenset({"accounts:read", "beneficiaries:read", "transfers:prepare"}),
        "knowledge": frozenset(),  # search_knowledge is bot-local.
    }


def test_parses_scopes_and_defaults_to_none() -> None:
    assert parse_skill(_SKILL.format(extra="")).scopes == frozenset()
    parsed = parse_skill(_SKILL.format(extra="scopes: [accounts:read, accounts:read, transfers:prepare]\n"))
    assert parsed.scopes == frozenset({"accounts:read", "transfers:prepare"})


@pytest.mark.parametrize(
    "scopes",
    [
        "accounts:read",
        "[accounts]",
        "[Accounts:Read]",
        "[accounts:read:all]",
        "['accounts:read transfers:prepare']",
        "[3]",
    ],
)
def test_rejects_malformed_scopes(scopes: str) -> None:
    with pytest.raises(ValidationError):
        parse_skill(_SKILL.format(extra=f"scopes: {scopes}\n"))


def test_rejects_an_approval_only_scope() -> None:
    with pytest.raises(ValidationError, match="approval-only"):
        parse_skill(_SKILL.format(extra="scopes: [accounts:read, transfers:execute]\n"))


def test_rejects_an_unknown_tier() -> None:
    with pytest.raises(ValidationError):
        parse_skill("---\nname: x\ndescription: d\ntools: [a]\nmax_tier: T9\n---\nbody")


def test_rejects_a_file_without_frontmatter() -> None:
    with pytest.raises(ValueError, match="frontmatter"):
        parse_skill("# no frontmatter")
