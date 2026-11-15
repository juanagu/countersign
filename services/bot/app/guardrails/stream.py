"""Wraps the AG-UI event stream of one run: nothing but RUN_STARTED leaves before the input verdict.

The agent runs in its own task from the start, so the first orchestrator call overlaps the input classifier.
Its events are held until the verdict: on allow they go through the output guard, on block the run is
cancelled and the customer gets a safe reply instead.
"""

import asyncio
import contextlib
import logging
from collections.abc import AsyncIterator, Callable, Collection, Iterator

from ag_ui.core import BaseEvent, EventType, RunErrorEvent, RunFinishedEvent, RunStartedEvent

from app.core.llm.run_record import current_run_record
from app.guardrails.input_classifier import SAFE_REPLIES
from app.guardrails.output_guard import OutputGuard, text_message
from app.guardrails.run_guard import RunGuard
from app.guardrails.stream_timing import StreamTimer
from app.guardrails.verdict import Verdict

logger = logging.getLogger(__name__)

CANCEL_GRACE_SECONDS = 2.0
_END = object()
_VERDICT = object()

Item = BaseEvent | object


async def _pump(events: AsyncIterator[BaseEvent], queue: "asyncio.Queue[Item]") -> None:
    """Drives the run in one task, so its tracing context stays in one place."""
    try:
        async for event in events:
            await queue.put(event)
    except Exception:
        logger.exception("agent stream failed")
        await queue.put(RunErrorEvent(type=EventType.RUN_ERROR, message="internal error"))
    finally:
        await queue.put(_END)


async def _announce_verdict(guard: RunGuard, queue: "asyncio.Queue[Item]") -> None:
    await guard.input_verdict()
    await queue.put(_VERDICT)


def refusal_text(verdict: Verdict) -> str:
    return verdict.text or SAFE_REPLIES["error"]


async def refusal_shown(guard: RunGuard) -> str | None:
    """The reply `guarded_stream` sends instead of this run's answer, or None when the verdict lets the answer out."""
    verdict = await guard.input_verdict()
    return refusal_text(verdict) if verdict.blocked else None


def blocked_reply(verdict: Verdict, *, started: bool, thread_id: str, run_id: str) -> Iterator[BaseEvent]:
    if not started:
        yield RunStartedEvent(type=EventType.RUN_STARTED, thread_id=thread_id, run_id=run_id)
    yield from text_message(refusal_text(verdict))
    yield RunFinishedEvent(type=EventType.RUN_FINISHED, thread_id=thread_id, run_id=run_id)


async def _stop(task: "asyncio.Task[None]", grace: float) -> None:
    if not task.done() and grace > 0:
        await asyncio.wait({task}, timeout=grace)
    if not task.done():
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task


class _HeldRun:
    """The stream's state: events are held until the verdict, then pass through the output guard."""

    def __init__(self, guard: RunGuard, *, thread_id: str, run_id: str, delegates: Collection[str]) -> None:
        self.output = OutputGuard(guard.evidence, delegates=delegates)
        self.held: list[BaseEvent] | None = []
        self.started = False
        self.blocked = False
        self._ids = {"thread_id": thread_id, "run_id": run_id}

    def on_event(self, event: BaseEvent) -> Iterator[BaseEvent]:
        if isinstance(event, RunStartedEvent) and not self.started:
            self.started = True
            yield event
        elif self.held is not None:
            self.held.append(event)
        else:
            yield from self.output.process(event)

    def on_verdict(self, verdict: Verdict) -> Iterator[BaseEvent]:
        if verdict.blocked:
            self.blocked = True
            yield from blocked_reply(verdict, started=self.started, **self._ids)
            return
        held, self.held = self.held or [], None
        for event in held:
            yield from self.output.process(event)


async def guarded_stream(
    events: AsyncIterator[BaseEvent],
    guard: RunGuard,
    *,
    thread_id: str,
    run_id: str,
    cancel_run: Callable[[], None],
    delegates: Collection[str] = frozenset(),
) -> AsyncIterator[BaseEvent]:
    """`delegates` names the delegate tools, whose calls the output guard withholds like `render_ui`'s."""
    queue: asyncio.Queue[Item] = asyncio.Queue()
    pump = asyncio.create_task(_pump(events, queue))
    announcer = asyncio.create_task(_announce_verdict(guard, queue))
    run = _HeldRun(guard, thread_id=thread_id, run_id=run_id, delegates=delegates)
    timer = StreamTimer(thread_id=thread_id)
    ended = decided = False
    try:
        while not ((ended and decided) or run.blocked):
            item = await queue.get()
            ended = ended or item is _END
            if item is _VERDICT:
                decided = True
                verdict = await guard.input_verdict()
                if verdict.blocked:
                    cancel_run()
                for event in run.on_verdict(verdict):
                    timer.observe(event)
                    yield event
            elif isinstance(item, BaseEvent):
                for event in run.on_event(item):
                    timer.observe(event)
                    yield event
    finally:
        record = current_run_record()
        timer.finish(record.span_attributes() if record is not None else {})
        announcer.cancel()
        guard.cancel()
        await _stop(pump, CANCEL_GRACE_SECONDS if run.blocked else 0.0)
