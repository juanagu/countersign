from app.policy.frequency_caps import Cap, FrequencyCaps
from app.policy.risk_tier import RiskTier


class Clock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_caps_writes_per_session_in_a_sliding_window() -> None:
    clock = Clock()
    caps = FrequencyCaps({RiskTier.T2: Cap(calls=2, window_seconds=60)}, clock=clock)
    session = ("ana", "thread-1")

    assert caps.acquire(session, RiskTier.T2) is None
    assert caps.acquire(session, RiskTier.T2) is None
    assert caps.acquire(session, RiskTier.T2) == "at most 2 T2 calls per conversation every 1 minutes"
    assert caps.acquire(("ana", "thread-2"), RiskTier.T2) is None  # Another conversation has its own count.
    assert caps.acquire(("juan", "thread-1"), RiskTier.T2) is None  # And so does another user.

    clock.now = 60
    assert caps.acquire(session, RiskTier.T2) is None


def test_uncapped_tiers_are_not_counted() -> None:
    caps = FrequencyCaps({RiskTier.T3: Cap(calls=1, window_seconds=60)})
    assert all(caps.acquire(("ana", "t"), RiskTier.T1) is None for _ in range(100))
