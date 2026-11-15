"""Per-session frequency caps for write tools (session = user + AG-UI thread), and a per-turn cap on delegations.
In memory, one bot process."""

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

# A turn needs one or two hand-offs to a domain agent; more is the orchestrator looping on its subagents.
DELEGATIONS_PER_TURN = 3
# A turn's delegation count is forgotten this long after its last delegation.
TURN_COUNT_TTL_SECONDS = 600.0

SessionKey = tuple[str, str]


@dataclass
class _TurnCount:
    turn: str
    calls: int
    last_at: float


class FrequencyCaps:
    """A sliding window per session and tier; only tiers with a cap are counted."""

    def __init__(
        self,
        caps: Mapping[RiskTier, Cap] = DEFAULT_CAPS,
        clock: Callable[[], float] = time.monotonic,
        delegations_per_turn: int = DELEGATIONS_PER_TURN,
    ):
        self._caps = caps
        self._clock = clock
        self._delegations_per_turn = delegations_per_turn
        self._calls: dict[tuple[str, str, RiskTier], deque[float]] = {}
        self._turns: dict[SessionKey, _TurnCount] = {}

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

    def acquire_delegation(self, session: SessionKey, turn: str) -> str | None:
        """Counts one delegation in `turn` (a run of the orchestrator), or returns the denial reason past the cap."""
        now = self._clock()
        self._prune(now)
        current = self._turns.get(session)
        calls = current.calls if current and current.turn == turn else 0
        if calls >= self._delegations_per_turn:
            return f"at most {self._delegations_per_turn} delegations per turn"
        self._turns[session] = _TurnCount(turn, calls + 1, now)
        return None

    def _prune(self, now: float) -> None:
        for session in [s for s, count in self._turns.items() if now - count.last_at >= TURN_COUNT_TTL_SECONDS]:
            del self._turns[session]
        for key in list(self._calls):
            window = self._caps[key[2]].window_seconds
            calls = self._calls[key]
            while calls and now - calls[0] >= window:
                calls.popleft()
            if not calls:
                del self._calls[key]
