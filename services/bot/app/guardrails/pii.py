"""Regex + checksum PII detection for Argentine banking data, and the one `redact()` used before logging."""

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from app.guardrails.verdict import ALLOW, Action, Verdict

CUIT_PREFIXES = ("20", "23", "24", "27", "30", "33", "34")
_CUIT_WEIGHTS = (5, 4, 3, 2, 7, 6, 5, 4, 3, 2)
# The bank's toll-free lines are public, not personal data.
TOLL_FREE_PREFIX = "0800"


def luhn_valid(digits: str) -> bool:
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char) * (2 if index % 2 else 1)
        total += value - 9 if value > 9 else value
    return total % 10 == 0


def cuit_valid(digits: str) -> bool:
    if len(digits) != 11 or not digits.startswith(CUIT_PREFIXES):
        return False
    remainder = sum(int(d) * w for d, w in zip(digits, _CUIT_WEIGHTS, strict=False)) % 11
    check = 0 if remainder == 0 else 11 - remainder
    return check < 10 and check == int(digits[-1])


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text)


@dataclass(frozen=True)
class Detector:
    kind: str
    pattern: re.Pattern[str]
    valid: Callable[[str], bool] = lambda _: True
    group: int = 0  # The part of the match that is replaced (DNI keeps its keyword).

    @property
    def label(self) -> str:
        return f"[{self.kind}]"


# Order matters: longer and checksum-backed formats go first, so a card number is never half-read as an account.
DETECTORS: tuple[Detector, ...] = (
    Detector("token", re.compile(r"\beyJ[\w-]{5,}\.[\w-]{5,}\.[\w-]*|\bBearer\s+[\w.~+/-]+=*")),
    Detector("email", re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")),
    Detector("cbu", re.compile(r"(?<!\d)\d{22}(?!\d)")),
    Detector(
        "tarjeta",
        re.compile(r"(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])"),
        lambda m: 13 <= len(_digits(m)) <= 19 and luhn_valid(_digits(m)),
    ),
    Detector("cuil", re.compile(r"(?<![\d-])\d{2}-?\d{8}-?\d(?![\d-])"), lambda m: cuit_valid(_digits(m))),
    Detector("cuenta", re.compile(r"(?<![\d-])\d{4}-\d{4}-\d{4}(?![\d-])")),
    Detector("dni", re.compile(r"(?i)\bdni\b\D{0,12}?(\d{1,2}\.?\d{3}\.?\d{3})(?!\d)"), group=1),
    Detector(
        "teléfono",
        # Not part of a longer run of digit groups, such as a card number that failed its checksum.
        re.compile(
            r"(?<![\d\w])(?<!\d\s)(?:\+54\s?9?\s?)?(?:\(?0?\d{2,4}\)?[\s-]?)?(?:15[\s-]?)?\d{4}[\s-]\d{4}(?![\d-]|\s\d)"
        ),
        lambda m: not _digits(m).startswith(TOLL_FREE_PREFIX),
    ),
)


def _apply(detector: Detector, text: str, found: list[str]) -> str:
    def replace(match: re.Match[str]) -> str:
        if not detector.valid(match.group(detector.group)):
            return match.group(0)
        found.append(detector.kind)
        start, end = match.start(detector.group) - match.start(), match.end(detector.group) - match.start()
        whole = match.group(0)
        return whole[:start] + detector.label + whole[end:]

    return detector.pattern.sub(replace, text)


def redact_with_kinds(text: str) -> tuple[str, list[str]]:
    """The text with each PII value replaced by its label, and the kinds that were found."""
    found: list[str] = []
    for detector in DETECTORS:
        text = _apply(detector, text, found)
    return text, found


def redact(text: str) -> str:
    return redact_with_kinds(text)[0]


def redact_value(value: Any) -> Any:
    """Redacts every string inside a JSON-like value (dicts, lists, tuples); other values pass through."""
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, dict):
        return {key: redact_value(item) for key, item in value.items()}
    if isinstance(value, list | tuple):
        return type(value)(redact_value(item) for item in value)
    return value


def pii_check(text: str) -> Verdict:
    """Input check: PII is masked before the text reaches the classifier, the model, logs or traces."""
    redacted, kinds = redact_with_kinds(text)
    if not kinds:
        return ALLOW
    return Verdict(Action.REDACT, "personal data in the message", ",".join(sorted(set(kinds))), redacted)
