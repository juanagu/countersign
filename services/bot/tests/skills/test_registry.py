import pytest
from pydantic import ValidationError

from app.config import SKILLS_DIR
from app.policy.risk_tier import RiskTier
from app.skills.registry import SkillRegistry, parse_skill


def test_loads_the_shipped_skills() -> None:
    registry = SkillRegistry.from_dir(SKILLS_DIR)
    assert registry.names() == ["accounts", "knowledge", "payments"]
    accounts = registry.get("accounts")
    assert accounts is not None
    assert accounts.max_tier is RiskTier.T1
    assert "spending_summary" in accounts.tools
    assert "load_skill" in registry.index()


def test_rejects_an_unknown_tier() -> None:
    with pytest.raises(ValidationError):
        parse_skill("---\nname: x\ndescription: d\ntools: [a]\nmax_tier: T9\n---\nbody")


def test_rejects_a_file_without_frontmatter() -> None:
    with pytest.raises(ValueError, match="frontmatter"):
        parse_skill("# no frontmatter")
