from dataclasses import dataclass
from enum import StrEnum


class Action(StrEnum):
    ALLOW = "allow"
    REDACT = "redact"
    BLOCK = "block"


@dataclass(frozen=True)
class Verdict:
    """What a guardrail check decided. `text` is the redacted text for `redact`, or the reply for `block`."""

    action: Action
    reason: str = ""
    category: str = ""
    text: str | None = None

    @property
    def blocked(self) -> bool:
        return self.action is Action.BLOCK


ALLOW = Verdict(Action.ALLOW)


def block(reason: str, *, category: str = "", text: str | None = None) -> Verdict:
    return Verdict(Action.BLOCK, reason, category, text)
