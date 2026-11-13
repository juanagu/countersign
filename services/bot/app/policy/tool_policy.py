from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any

from app.policy.risk_tier import RiskTier
from app.skills.registry import SkillRegistry

MAX_TRANSACTIONS = 50
MAX_PERIOD_DAYS = 400
TRANSFER_CAPS = {"ARS": 2_000_000, "USD": 10_000}

ArgCheck = Callable[[Mapping[str, Any]], str | None]
"""Returns a denial reason, or None when the arguments are within bounds."""


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str = ""


def _period_too_long(args: Mapping[str, Any]) -> str | None:
    start, end = args.get("from"), args.get("to")
    if not (isinstance(start, str) and isinstance(end, str)):
        return None
    try:
        days = (date.fromisoformat(end) - date.fromisoformat(start)).days
    except ValueError:
        return "dates must be YYYY-MM-DD"
    if days < 0:
        return "the period ends before it starts"
    return f"periods are limited to {MAX_PERIOD_DAYS} days" if days > MAX_PERIOD_DAYS else None


def _transactions_bounds(args: Mapping[str, Any]) -> str | None:
    limit = args.get("limit")
    if isinstance(limit, int) and limit > MAX_TRANSACTIONS:
        return f"at most {MAX_TRANSACTIONS} transactions per call"
    return _period_too_long(args)


def _transfer_bounds(args: Mapping[str, Any]) -> str | None:
    amount, currency = args.get("amount"), args.get("currency")
    cap = TRANSFER_CAPS.get(currency) if isinstance(currency, str) else None
    if cap is None:
        return "unsupported currency"
    if not isinstance(amount, int | float) or isinstance(amount, bool) or amount <= 0:
        return "the amount must be a positive number"
    return f"transfers are capped at {cap} {currency}" if amount > cap else None


DEFAULT_ARG_CHECKS: Mapping[str, ArgCheck] = {
    "list_transactions": _transactions_bounds,
    "spending_summary": _period_too_long,
    "prepare_transfer": _transfer_bounds,
}


class ToolPolicy:
    """The single gate for domain tools: risk tier, loaded skill and argument bounds (security rule 2)."""

    def __init__(self, skills: SkillRegistry, arg_checks: Mapping[str, ArgCheck] = DEFAULT_ARG_CHECKS):
        self._skills = skills
        self._arg_checks = arg_checks

    def visible(self, tool: str, tier: RiskTier | None, loaded: set[str]) -> bool:
        return tier is not None and self._granted(tool, tier, loaded)

    def check_call(self, tool: str, tier: RiskTier | None, args: Mapping[str, Any], loaded: set[str]) -> Decision:
        if tier is None:
            return Decision(False, "the tool declares no risk tier")
        if not self._granted(tool, tier, loaded):
            return Decision(False, "no loaded skill grants this tool")
        if tier is RiskTier.T3:
            return Decision(False, "money movement needs the customer's approval in the app")
        check = self._arg_checks.get(tool)
        reason = check(args) if check else None
        return Decision(False, reason) if reason else Decision(True)

    def _granted(self, tool: str, tier: RiskTier, loaded: set[str]) -> bool:
        for name in loaded:
            skill = self._skills.get(name)
            if skill and tool in skill.tools and tier <= skill.max_tier:
                return True
        return False
