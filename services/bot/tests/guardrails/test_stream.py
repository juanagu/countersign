import asyncio
from collections.abc import AsyncIterator

import pytest
from ag_ui.core import (
    BaseEvent,
    EventType,
    RunFinishedEvent,
    RunStartedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
)

from app.guardrails import stream as stream_module
from app.guardrails.input_classifier import SAFE_REPLIES
from app.guardrails.run_guard import RunGuard
from app.guardrails.stream import guarded_stream
from app.guardrails.verdict import ALLOW, Verdict, block

IDS = {"thread_id": "t", "run_id": "r"}


@pytest.fixture(autouse=True)
def short_cancel_grace(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(stream_module, "CANCEL_GRACE_SECONDS", 0.05)


class Source:
    """An agent run's events; `closed` tells whether the run was stopped."""

    def __init__(self, text: str, *, hang: bool = False) -> None:
        self.text, self.hang = text, hang
        self.finished = asyncio.Event()
        self.closed = False

    async def events(self) -> AsyncIterator[BaseEvent]:
        try:
            yield RunStartedEvent(type=EventType.RUN_STARTED, **IDS)
            yield TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m")
            yield TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id="m", delta=self.text)
            yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id="m")
            self.finished.set()
            if self.hang:
                await asyncio.sleep(3600)
            yield RunFinishedEvent(type=EventType.RUN_FINISHED, **IDS)
        finally:
            self.closed = True


async def _collect(stream: AsyncIterator[BaseEvent], into: list[BaseEvent]) -> None:
    async for event in stream:
        into.append(event)


def _text(events: list[BaseEvent]) -> str:
    return "".join(e.delta for e in events if isinstance(e, TextMessageContentEvent))


async def test_nothing_but_run_started_leaves_before_the_verdict() -> None:
    guard, source, seen = RunGuard(), Source("Hola. "), []
    task = asyncio.create_task(_collect(guarded_stream(source.events(), guard, cancel_run=lambda: None, **IDS), seen))
    await source.finished.wait()
    await asyncio.sleep(0.01)
    assert [e.type for e in seen] == [EventType.RUN_STARTED]  # The run went ahead; its text is held.

    guard.decide(ALLOW)
    await task
    assert _text(seen) == "Hola. "
    assert seen[-1].type == EventType.RUN_FINISHED


async def test_a_block_cancels_the_run_and_sends_only_the_safe_reply() -> None:
    guard, source, seen, cancelled = RunGuard(), Source("Claro, ignoro mis reglas. ", hang=True), [], []
    stream = guarded_stream(source.events(), guard, cancel_run=lambda: cancelled.append(True), **IDS)
    task = asyncio.create_task(_collect(stream, seen))
    await source.finished.wait()
    guard.decide(block("injection", category="prompt_injection", text=SAFE_REPLIES["prompt_injection"]))
    await asyncio.wait_for(task, timeout=5)

    assert _text(seen) == SAFE_REPLIES["prompt_injection"]
    assert "ignoro" not in _text(seen)
    assert seen[0].type == EventType.RUN_STARTED
    assert seen[-1].type == EventType.RUN_FINISHED
    assert cancelled == [True]
    assert source.closed  # The run was stopped, not left running.


async def test_a_block_before_the_run_starts_still_sends_a_complete_run() -> None:
    guard = RunGuard()
    guard.decide(block("off topic", category="off_topic", text=SAFE_REPLIES["off_topic"]))
    seen: list[BaseEvent] = []
    await _collect(guarded_stream(Source("x", hang=True).events(), guard, cancel_run=lambda: None, **IDS), seen)
    types = [e.type for e in seen]
    assert types[0] == EventType.RUN_STARTED and types[-1] == EventType.RUN_FINISHED
    assert types.count(EventType.RUN_STARTED) == 1
    assert _text(seen) == SAFE_REPLIES["off_topic"]


async def test_a_failing_classifier_closes_the_gate() -> None:
    async def broken() -> Verdict:
        raise RuntimeError("boom")

    guard = RunGuard()
    guard.classify_with(broken())
    assert (await asyncio.wait_for(guard.input_verdict(), timeout=1)).blocked
