from app.policy.frequency_caps import TURN_COUNT_TTL_SECONDS, Cap, FrequencyCaps
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


def test_delegations_are_capped_per_turn_and_a_new_turn_counts_afresh() -> None:
    clock = Clock()
    caps = FrequencyCaps(clock=clock, delegations_per_turn=2)
    session = ("ana", "t")

    assert caps.acquire_delegation(session, "run-1") is None
    assert caps.acquire_delegation(session, "run-1") is None
    assert caps.acquire_delegation(session, "run-1") == "at most 2 delegations per turn"
    assert caps.acquire_delegation(("ana", "t2"), "run-1") is None  # Another conversation has its own count.
    assert caps.acquire_delegation(session, "run-2") is None
    assert caps.acquire(session, RiskTier.T2) is None  # Delegations are not T2 writes.

    caps.acquire_delegation(session, "run-2")
    clock.now = TURN_COUNT_TTL_SECONDS
    assert caps.acquire_delegation(session, "run-2") is None  # A forgotten turn starts again.
