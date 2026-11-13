from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

DEFAULT_BANK_TIMEZONE = "America/Argentina/Buenos_Aires"


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True)
class BankClock:
    """The bank's calendar. The container runs in UTC, but a customer's "today" is the bank's local day."""

    tz: ZoneInfo = field(default_factory=lambda: ZoneInfo(DEFAULT_BANK_TIMEZONE))
    now: Callable[[], datetime] = _utc_now  # Injected by tests to pin the instant.

    def today(self) -> date:
        return self.now().astimezone(self.tz).date()
