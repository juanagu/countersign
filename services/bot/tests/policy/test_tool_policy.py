from typing import Any

import pytest

from app.config import SKILLS_DIR
from app.policy.risk_tier import RiskTier
from app.policy.tool_policy import ToolPolicy
from app.skills.registry import SkillRegistry

POLICY = ToolPolicy(SkillRegistry.from_dir(SKILLS_DIR))
T1, T2, T3 = RiskTier.T1, RiskTier.T2, RiskTier.T3


def test_hides_domain_tools_until_their_skill_is_loaded() -> None:
    assert not POLICY.visible("get_balance", T1, set())
    assert POLICY.visible("get_balance", T1, {"accounts"})
    assert not POLICY.visible("prepare_transfer", T2, {"accounts"})


def test_hides_a_tool_whose_tier_exceeds_the_skill_max_tier() -> None:
    # A server that started declaring list_accounts as T2 would no longer be granted by accounts (max T1).
    assert not POLICY.visible("list_accounts", T2, {"accounts"})


def test_denies_a_tool_without_a_declared_tier() -> None:
    assert not POLICY.visible("get_balance", None, {"accounts"})
    assert not POLICY.check_call("get_balance", None, {}, {"accounts"}).allowed


def test_denies_money_movement_without_approval() -> None:
    decision = POLICY.check_call("execute_transfer", T3, {"draft_id": "d"}, {"payments"})
    assert not decision.allowed
    assert "approval" in decision.reason


def test_allows_a_granted_call_within_bounds() -> None:
    args = {"source_account_id": "a", "beneficiary_id": "b", "amount": 50000, "currency": "ARS"}
    assert POLICY.check_call("prepare_transfer", T2, args, {"payments"}).allowed


@pytest.mark.parametrize(
    ("tool", "tier", "args"),
    [
        ("list_transactions", T1, {"limit": 51}),
        ("list_transactions", T1, {"from": "2025-01-01", "to": "2026-12-31"}),
        ("spending_summary", T1, {"from": "2026-10-31", "to": "2026-10-01"}),
        ("spending_summary", T1, {"from": "yesterday", "to": "today"}),
        ("prepare_transfer", T2, {"amount": 2_000_001, "currency": "ARS"}),
        ("prepare_transfer", T2, {"amount": -5, "currency": "ARS"}),
        ("prepare_transfer", T2, {"amount": True, "currency": "ARS"}),
        ("prepare_transfer", T2, {"amount": 10, "currency": "BTC"}),
    ],
)
def test_denies_arguments_out_of_bounds(tool: str, tier: RiskTier, args: dict[str, Any]) -> None:
    assert not POLICY.check_call(tool, tier, args, {"accounts", "payments"}).allowed
