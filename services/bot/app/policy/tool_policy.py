import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date
from typing import Any

from app.core.clock import BankClock
from app.policy.risk_tier import RiskTier
from app.skills.registry import SkillRegistry

MAX_TRANSACTIONS = 50
MAX_PERIOD_DAYS = 400
TRANSFER_CAPS = {"ARS": 2_000_000, "USD": 10_000}
_ISO_DAY = re.compile(r"\d{4}-\d{2}-\d{2}")

NO_TIER = "the tool declares no risk tier"
PREPARE_TRANSFER = "prepare_transfer"
# Tools whose `draft_id` must name the conversation's open draft: the one value that crosses from a subagent's answer
# into a T3 call is checked in code, not trusted.
DRAFT_BOUND_TOOLS = frozenset({"execute_transfer"})

ArgCheck = Callable[[Mapping[str, Any], date], str | None]
"""Given the arguments and the bank's today, returns a denial reason, or None when they are within bounds."""


@dataclass(frozen=True)
class Decision:
    allowed: bool
    reason: str = ""
    # Money movement runs only after the customer approves it in the app (security rule 3).
    needs_approval: bool = False


def _day(args: Mapping[str, Any], key: str) -> date | None:
    """None when absent; raises ValueError for anything else that is not a YYYY-MM-DD string."""
    if key not in args:
        return None
    value = args[key]
    if not (isinstance(value, str) and _ISO_DAY.fullmatch(value)):
        raise ValueError(key)
    return date.fromisoformat(value)


def _period_bounds(args: Mapping[str, Any], today: date, *, start_required: bool) -> str | None:
    try:
        start, end = _day(args, "from"), _day(args, "to") or today  # Open-ended runs up to today.
    except ValueError:
        return "dates must be YYYY-MM-DD"
    if start is None:
        return "the period needs a start date" if start_required else None
    days = (end - start).days
    if days < 0:
        return "the period ends before it starts"
    return f"periods are limited to {MAX_PERIOD_DAYS} days" if days > MAX_PERIOD_DAYS else None


def _summary_bounds(args: Mapping[str, Any], today: date) -> str | None:
    return _period_bounds(args, today, start_required=True)


def _transactions_bounds(args: Mapping[str, Any], today: date) -> str | None:
    limit = args.get("limit", 1)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= MAX_TRANSACTIONS:
        return f"limit must be a whole number from 1 to {MAX_TRANSACTIONS}"
    # Without a start date the period is bounded by the limit alone.
    return _period_bounds(args, today, start_required=False)


def _transfer_bounds(args: Mapping[str, Any], _today: date) -> str | None:
    amount, currency = args.get("amount"), args.get("currency")
    cap = TRANSFER_CAPS.get(currency) if isinstance(currency, str) else None
    if cap is None:
        return "unsupported currency"
    if not isinstance(amount, int | float) or isinstance(amount, bool) or amount <= 0:
        return "the amount must be a positive number"
    return f"transfers are capped at {cap} {currency}" if amount > cap else None


def prepared_draft_id(content: Any) -> str | None:
    """The draft id in a `prepare_transfer` result, raw or as the policy wrapped it; None for an error."""
    if isinstance(content, Mapping) and "untrusted_data" in content:
        content = content["untrusted_data"]
    if not isinstance(content, Mapping) or "error" in content:
        return None
    draft_id = content.get("draft_id")
    return draft_id if isinstance(draft_id, str) and draft_id else None


def _names_open_draft(args: Mapping[str, Any], open_draft: str | None) -> bool:
    draft = args.get("draft_id")
    return isinstance(draft, str) and open_draft is not None and draft == open_draft


DEFAULT_ARG_CHECKS: Mapping[str, ArgCheck] = {
    "list_transactions": _transactions_bounds,
    "spending_summary": _summary_bounds,
    "prepare_transfer": _transfer_bounds,
}


class ToolPolicy:
    """The single gate for domain tools: risk tier, loaded skill and argument bounds (security rule 2)."""

    def __init__(
        self,
        skills: SkillRegistry,
        arg_checks: Mapping[str, ArgCheck] = DEFAULT_ARG_CHECKS,
        clock: BankClock | None = None,
    ):
        self._skills = skills
        self._arg_checks = arg_checks
        self._clock = clock or BankClock()

    def visible(self, tool: str, tier: RiskTier | None, loaded: set[str]) -> bool:
        return tier is not None and self._granted(tool, tier, loaded)

    def check_call(
        self,
        tool: str,
        tier: RiskTier | None,
        args: Mapping[str, Any],
        loaded: set[str],
        open_draft: str | None = None,
    ) -> Decision:
        """`open_draft` is the conversation's one draft that no `execute_transfer` result decided yet."""
        if tier is None:
            return Decision(False, NO_TIER)
        if not self._granted(tool, tier, loaded):
            return Decision(False, "no loaded skill grants this tool")
        if tool in DRAFT_BOUND_TOOLS and not _names_open_draft(args, open_draft):
            return Decision(False, "the draft is not this conversation's open draft")
        check = self._arg_checks.get(tool)
        reason = check(args, self._clock.today()) if check else None
        if not reason and tier is RiskTier.T3:
            return Decision(True, needs_approval=True)
        return Decision(False, reason) if reason else Decision(True)

    def _granted(self, tool: str, tier: RiskTier, loaded: set[str]) -> bool:
        for name in loaded:
            skill = self._skills.get(name)
            if skill and tool in skill.tools and tier <= skill.max_tier:
                return True
        return False
