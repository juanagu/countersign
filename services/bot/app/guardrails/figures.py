"""Finds the figures in a text (amounts, percentages, dates, account numbers) and normalises es-AR formats.

`$ 1.254.300,50`, `1254300.50` and `1.254.300,5` are the same amount; `****4521` names an account by its last
digits. An ambiguous token such as `50.000` (fifty thousand in es-AR, fifty in en-US) yields both readings.
"""

import re
from collections.abc import Iterator
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation

MONTHS: tuple[str, ...] = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto")
MONTHS += ("septiembre", "octubre", "noviembre", "diciembre")
_MONTH_INDEX = {name: index + 1 for index, name in enumerate(MONTHS)} | {"setiembre": 9}
_MONTH_NAMES = "|".join(_MONTH_INDEX)

ISO_DATE = re.compile(r"(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)")
SLASH_DATE = re.compile(r"(?<![\d/])(\d{1,2})/(\d{1,2})(?:/(\d{4}|\d{2}))?(?![\d/])")
WORD_DATE = re.compile(rf"(?i)(?:\b(\d{{1,2}})\s+de\s+)?\b({_MONTH_NAMES})\b(?:\s+(?:de|del)\s+(\d{{4}}))?")
MASKED_ACCOUNT = re.compile(r"[*•]{2,}\s?(\d{2,6})(?!\d)")
# Three or more, so `**1.234**` stays bold: an asterisk mask inside markdown bold closes the bold early.
ASTERISK_MASK = re.compile(r"\*{3,}\s?(\d{2,6})(?!\d)")
BULLET_MASK = "••••"
FULL_ACCOUNT = re.compile(r"(?<![\d-])(?:\d{4}-\d{4}-\d{4}|\d{10,22})(?![\d-])")
NUMBER = re.compile(r"(?<![\w])\d+(?:[.,]\d+)*(?![\w])")
CURRENCY_BEFORE = re.compile(r"(?i)(?:US\$|U\$S|USD|ARS|\$)\s?$")
UNIT_AFTER = re.compile(r"(?i)^\s?(?:%|por ciento|pesos|d[oó]lares|usd|ars)")

SIGNIFICANT = Decimal(1000)
_CONTEXT = 6  # Characters looked at before a number for a currency marker,
_UNIT_CONTEXT = 12  # and after it for a unit ("por ciento").


@dataclass(frozen=True)
class DateRef:
    """A calendar date as written: any part may be missing ("15/10", "octubre de 2026")."""

    year: int | None
    month: int
    day: int | None

    def matches(self, other: "DateRef") -> bool:
        def same(a: int | None, b: int | None) -> bool:
            return a is None or b is None or a == b

        return self.month == other.month and same(self.year, other.year) and same(self.day, other.day)


@dataclass(frozen=True)
class Amount:
    token: str
    candidates: frozenset[Decimal]
    marked: bool  # Written with a currency symbol or a unit, so it is a figure whatever its size.

    @property
    def significant(self) -> bool:
        return self.marked or any(c >= SIGNIFICANT or c != c.to_integral_value() for c in self.candidates)


def _decimal(text: str) -> Decimal | None:
    try:
        return abs(Decimal(text))
    except InvalidOperation:
        return None


def _readings(token: str) -> set[str]:
    if "." in token and "," in token:
        decimal_sep = "," if token.rfind(",") > token.rfind(".") else "."
        thousands = "." if decimal_sep == "," else ","
        return {token.replace(thousands, "").replace(decimal_sep, ".")}
    for sep in (".", ","):
        parts = token.split(sep)
        if len(parts) > 2:
            return {"".join(parts)} if all(len(p) == 3 for p in parts[1:]) else set()
        if len(parts) == 2:
            head, tail = parts
            return {f"{head}.{tail}", head + tail} if len(tail) == 3 else {f"{head}.{tail}"}
    return {token}


def number_candidates(token: str) -> frozenset[Decimal]:
    """Every value the written number can mean, as non-negative decimals."""
    values = (_decimal(reading) for reading in _readings(token))
    return frozenset(value for value in values if value is not None)


def _valid_date(year: int | None, month: int, day: int | None) -> DateRef | None:
    try:
        date(year or 2000, month, day or 1)
    except ValueError:
        return None
    return DateRef(year, month, day)


def _year(text: str | None) -> int | None:
    if not text:
        return None
    return int(text) + 2000 if len(text) == 2 else int(text)


def find_dates(text: str) -> list[tuple[DateRef, tuple[int, int]]]:
    found: list[tuple[DateRef, tuple[int, int]]] = []
    for match in ISO_DATE.finditer(text):
        ref = _valid_date(int(match[1]), int(match[2]), int(match[3]))
        found += [(ref, match.span())] if ref else []
    for match in SLASH_DATE.finditer(text):
        ref = _valid_date(_year(match[3]), int(match[2]), int(match[1]))
        found += [(ref, match.span())] if ref else []
    for match in WORD_DATE.finditer(text):
        if not (match[1] or match[3]):
            continue  # A bare month name carries no figure.
        ref = _valid_date(_year(match[3]), _MONTH_INDEX[match[2].lower()], int(match[1]) if match[1] else None)
        found += [(ref, match.span())] if ref else []
    return found


def _blank(text: str, spans: list[tuple[int, int]]) -> str:
    chars = list(text)
    for start, end in spans:
        chars[start:end] = " " * (end - start)
    return "".join(chars)


@dataclass(frozen=True)
class Figures:
    amounts: tuple[Amount, ...]
    dates: tuple[DateRef, ...]
    masked_accounts: tuple[str, ...]  # Trailing digits of `••••4521` (or `****4521`) numbers.
    full_accounts: tuple[str, ...]  # Digits only.

    @property
    def empty(self) -> bool:
        return not (self.amounts or self.dates or self.masked_accounts or self.full_accounts)


def _amounts(text: str) -> Iterator[Amount]:
    for match in NUMBER.finditer(text):
        before = text[max(0, match.start() - _CONTEXT) : match.start()]
        after = text[match.end() : match.end() + _UNIT_CONTEXT]
        marked = bool(CURRENCY_BEFORE.search(before) or UNIT_AFTER.search(after))
        candidates = number_candidates(match.group(0))
        if candidates:
            yield Amount(match.group(0), candidates, marked)


def extract(text: str) -> Figures:
    """Dates and account numbers are read first and blanked, so their digits are not read again as amounts."""
    dated = find_dates(text)
    masked = [(m[1], m.span()) for m in MASKED_ACCOUNT.finditer(text)]
    full = [(re.sub(r"\D", "", m[0]), m.span()) for m in FULL_ACCOUNT.finditer(text)]
    spans = [span for _, span in dated] + [span for _, span in masked] + [span for _, span in full]
    rest = _blank(text, spans)
    return Figures(
        amounts=tuple(_amounts(rest)),
        dates=tuple(ref for ref, _ in dated),
        masked_accounts=tuple(digits for digits, _ in masked),
        full_accounts=tuple(digits for digits, _ in full),
    )


def bullet_masks(text: str) -> str:
    """`****7810` → `••••7810`, so a masked account reads the same and never breaks the markdown around it."""
    return ASTERISK_MASK.sub(lambda match: BULLET_MASK + match[1], text)
