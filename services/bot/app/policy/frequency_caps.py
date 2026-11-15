"""Per-session frequency caps for write tools (session = user + AG-UI thread). In memory, one bot process."""

import time
from collections import deque
from collections.abc import Callable, Mapping
from dataclasses import dataclass

from app.policy.risk_tier import RiskTier


@dataclass(frozen=True)
class Cap:
    calls: int
    window_seconds: float


# A customer prepares a handful of transfers in a conversation and executes fewer; more is a loop or an attack.
DEFAULT_CAPS: Mapping[RiskTier, Cap] = {
    RiskTier.T2: Cap(calls=5, window_seconds=600),
    RiskTier.T3: Cap(calls=3, window_seconds=600),
}

SessionKey = tuple[str, str]


class FrequencyCaps:
    """A sliding window per session and tier; only tiers with a cap are counted."""

    def __init__(self, caps: Mapping[RiskTier, Cap] = DEFAULT_CAPS, clock: Callable[[], float] = time.monotonic):
        self._caps = caps
        self._clock = clock
        self._calls: dict[tuple[str, str, RiskTier], deque[float]] = {}

    def acquire(self, session: SessionKey, tier: RiskTier) -> str | None:
        """Counts one call, or returns the denial reason when the session is over its cap."""
        cap = self._caps.get(tier)
        if cap is None:
            return None
        now = self._clock()
        self._prune(now)
        calls = self._calls.setdefault((*session, tier), deque())
        if len(calls) >= cap.calls:
            minutes = round(cap.window_seconds / 60)
            return f"at most {cap.calls} {tier.name} calls per conversation every {minutes} minutes"
        calls.append(now)
        return None

    def _prune(self, now: float) -> None:
        for key in list(self._calls):
            window = self._caps[key[2]].window_seconds
            calls = self._calls[key]
            while calls and now - calls[0] >= window:
                calls.popleft()
            if not calls:
                del self._calls[key]
