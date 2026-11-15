from datetime import UTC, datetime
from typing import Any

import pytest

from app.core.clock import BankClock
from app.policy.risk_tier import RiskTier
from app.policy.tool_policy import Decision, ToolPolicy
from app.skills.registry import SkillRegistry
from tests.conftest import TEST_SKILLS_DIR

# Pinned at 22:00 ART on Nov 30, which is already Dec 1 in UTC.
CLOCK = BankClock(now=lambda: datetime(2026, 12, 1, 1, 0, tzinfo=UTC))
POLICY = ToolPolicy(SkillRegistry.from_dir(TEST_SKILLS_DIR), clock=CLOCK)
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


def test_money_movement_is_allowed_only_through_approval() -> None:
    decision = POLICY.check_call("execute_transfer", T3, {"draft_id": "d"}, {"payments"}, "d")
    assert decision.allowed
    assert decision.needs_approval
    assert not POLICY.check_call("execute_transfer", T3, {"draft_id": "d"}, {"accounts"}, "d").allowed


# The draft id is the one value crossing from a subagent's answer into a T3 call, so code checks it; a value that is
# not a string is a denial, never an error.
@pytest.mark.parametrize(
    "args",
    [{"draft_id": "other"}, {"draft_id": None}, {}, {"draft_id": ["d"]}, {"draft_id": {"d": 1}}, {"draft_id": 7}],
)
def test_money_movement_needs_the_conversations_open_draft(args: dict[str, object]) -> None:
    decision = POLICY.check_call("execute_transfer", T3, args, {"payments"}, "d")
    assert not decision.allowed and not decision.needs_approval
    assert decision.reason == "the draft is not this conversation's open draft"
    assert not POLICY.check_call("execute_transfer", T3, {"draft_id": "d"}, {"payments"}).allowed


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
        # Fail closed: a missing end runs up to today, wrong types are denied, not skipped.
        ("list_transactions", T1, {"from": "2000-01-01"}),
        ("spending_summary", T1, {"from": "2000-01-01"}),
        ("spending_summary", T1, {"to": "2026-10-31"}),
        ("spending_summary", T1, {}),
        ("list_transactions", T1, {"limit": 100.0}),
        ("list_transactions", T1, {"limit": True}),
        ("list_transactions", T1, {"limit": "100"}),
        ("list_transactions", T1, {"limit": 0}),
        ("list_transactions", T1, {"from": 20250101, "to": "2025-01-31"}),
        ("list_transactions", T1, {"from": "2025-01-01", "to": None}),
        ("spending_summary", T1, {"from": ["2025-01-01"], "to": "2025-01-31"}),
        ("spending_summary", T1, {"from": "20250101", "to": "2025-01-31"}),
        ("prepare_transfer", T2, {"amount": 2_000_001, "currency": "ARS"}),
        ("prepare_transfer", T2, {"amount": -5, "currency": "ARS"}),
        ("prepare_transfer", T2, {"amount": True, "currency": "ARS"}),
        ("prepare_transfer", T2, {"amount": 10, "currency": "BTC"}),
    ],
)
def test_denies_arguments_out_of_bounds(tool: str, tier: RiskTier, args: dict[str, Any]) -> None:
    assert not POLICY.check_call(tool, tier, args, {"accounts", "payments"}).allowed


@pytest.mark.parametrize(
    ("tool", "args"),
    [
        ("list_transactions", {}),
        ("list_transactions", {"limit": 50}),
        ("list_transactions", {"to": "2026-10-31", "limit": 10}),
        ("list_transactions", {"from": "2026-11-01"}),
        ("spending_summary", {"from": "2026-10-01", "to": "2026-10-31"}),
    ],
)
def test_allows_periods_and_limits_within_bounds(tool: str, args: dict[str, Any]) -> None:
    assert POLICY.check_call(tool, T1, args, {"accounts"}).allowed


def test_an_open_ended_period_ends_on_the_banks_today_not_utcs() -> None:
    # In UTC this is "from today"; on the bank's calendar Dec 1 is still tomorrow.
    decision = POLICY.check_call("list_transactions", T1, {"from": "2026-12-01"}, {"accounts"})
    assert decision == Decision(False, "the period ends before it starts")
    assert POLICY.check_call("list_transactions", T1, {"from": "2026-11-30"}, {"accounts"}).allowed
