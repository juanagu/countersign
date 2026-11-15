from app.guardrails.pending_approvals import PendingApprovals

JUAN = ("juan", "thread-1")


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def test_a_raised_interrupt_is_consumed_once() -> None:
    pending = PendingApprovals()
    pending.record(JUAN, ["call_1"])
    assert pending.consume(JUAN, ["call_1"])
    assert not pending.consume(JUAN, ["call_1"])  # A replayed resume is classified as usual.


def test_an_interrupt_belongs_to_its_user_and_thread() -> None:
    pending = PendingApprovals()
    pending.record(JUAN, ["call_1"])
    assert not pending.consume(("ana", "thread-1"), ["call_1"])
    assert not pending.consume(("juan", "thread-2"), ["call_1"])
    assert pending.consume(JUAN, ["call_1"])


def test_every_resumed_call_must_be_pending() -> None:
    pending = PendingApprovals()
    pending.record(JUAN, ["call_1"])
    assert not pending.consume(JUAN, ["call_1", "call_forged"])
    assert not pending.consume(JUAN, [])


def test_an_interrupt_expires_with_its_draft() -> None:
    clock = FakeClock()
    pending = PendingApprovals(ttl_seconds=300, clock=clock)
    pending.record(JUAN, ["call_1"])
    clock.now = 301
    assert not pending.consume(JUAN, ["call_1"])
