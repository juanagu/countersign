"""Grounding: every figure the assistant states must appear in the data this run was given."""

from collections.abc import Iterator, Mapping
from dataclasses import asdict, dataclass, field, is_dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Any

from pydantic import BaseModel

from app.guardrails.figures import Amount, DateRef, extract

# Keys of an A2UI operation that are plumbing, not values the customer reads.
SURFACE_PLUMBING_KEYS = frozenset({"id", "surfaceId", "catalogId", "version", "component", "children", "docId"})


@dataclass
class Evidence:
    """The figures found in this run's tool results, plus the trusted server context (today's date)."""

    numbers: set[Decimal] = field(default_factory=set)
    dates: list[DateRef] = field(default_factory=list)
    masked_accounts: set[str] = field(default_factory=set)
    full_accounts: set[str] = field(default_factory=set)

    def add(self, value: Any) -> None:
        """Walks a JSON-like value: numbers are taken as they are, strings are read for written figures."""
        if isinstance(value, bool) or value is None:
            return
        if isinstance(value, int | float | Decimal):
            self._add_number(value)
        elif isinstance(value, str):
            self.add_text(value)
        elif isinstance(value, Mapping):
            for item in value.values():
                self.add(item)
        elif isinstance(value, list | tuple | set):
            for item in value:
                self.add(item)
        elif isinstance(value, BaseModel):
            self.add(value.model_dump(mode="json"))
        elif is_dataclass(value) and not isinstance(value, type):
            self.add(asdict(value))

    def add_text(self, text: str) -> None:
        figures = extract(text)
        for amount in figures.amounts:
            self.numbers.update(amount.candidates)
        for ref in figures.dates:
            self.dates.append(ref)
            if ref.year:
                self.numbers.add(Decimal(ref.year))
        self.masked_accounts.update(figures.masked_accounts)
        self.full_accounts.update(figures.full_accounts)

    def add_date(self, day: date) -> None:
        self.add_text(day.isoformat())

    def _add_number(self, value: int | float | Decimal) -> None:
        try:
            self.numbers.add(abs(Decimal(str(value))))
        except InvalidOperation:
            return

    def has_amount(self, amount: Amount) -> bool:
        return not self.numbers.isdisjoint(amount.candidates)

    def has_date(self, ref: DateRef) -> bool:
        return any(ref.matches(known) for known in self.dates)

    def has_masked(self, digits: str) -> bool:
        return any(known.endswith(digits) or digits.endswith(known) for known in self.masked_accounts)


def ungrounded(text: str, evidence: Evidence) -> list[str]:
    """The figures in `text` that the evidence does not contain (empty when the text is grounded)."""
    figures = extract(text)
    missing = [a.token for a in figures.amounts if a.significant and not evidence.has_amount(a)]
    missing += [f"{d.day}/{d.month}/{d.year}" for d in figures.dates if not evidence.has_date(d)]
    missing += [f"****{m}" for m in figures.masked_accounts if not evidence.has_masked(m)]
    missing += [f for f in figures.full_accounts if f not in evidence.full_accounts]
    return missing


def _surface_values(value: Any, key: str = "") -> Iterator[Any]:
    if key in SURFACE_PLUMBING_KEYS:
        return
    if isinstance(value, Mapping):
        for child_key, child in value.items():
            yield from _surface_values(child, str(child_key))
    elif isinstance(value, list | tuple):
        for child in value:
            yield from _surface_values(child, key)
    else:
        yield value


def ungrounded_in_surface(content: Any, evidence: Evidence) -> list[str]:
    """Numbers and written figures inside an A2UI surface, checked like text (ADR 012)."""
    missing: list[str] = []
    for value in _surface_values(content):
        if isinstance(value, bool) or value is None:
            continue
        if isinstance(value, int | float):
            missing += ungrounded(f"{value}", evidence)
        elif isinstance(value, str):
            missing += ungrounded(value, evidence)
    return missing
