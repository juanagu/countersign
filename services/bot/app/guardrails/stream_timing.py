"""How fast one run reached the customer: time to the first text delta and to the first UI surface.

Measured on what leaves the bot, after the input gate and the sentence-by-sentence output guard, so it is the
latency the customer feels. Recorded on a `bot.stream` span and one log line; neither carries content. The span
also says which models served the run and how many failovers it took (ADR 018).
"""

import logging
import time
from collections.abc import Callable, Mapping

from ag_ui.core import ActivitySnapshotEvent, BaseEvent, TextMessageContentEvent
from opentelemetry import trace
from opentelemetry.util.types import AttributeValue

logger = logging.getLogger(__name__)

STREAM_SPAN = "bot.stream"
TTFT_ATTRIBUTE = "bot.time_to_first_token_ms"
FIRST_SURFACE_ATTRIBUTE = "bot.time_to_first_surface_ms"
DURATION_ATTRIBUTE = "bot.stream_duration_ms"
# The AG-UI thread (a random id, no content): an eval finds a run's trace by it (`evals/delegation.py`, ADR 021).
THREAD_ATTRIBUTE = "bot.thread_id"
TIMING_METRIC = "bot.stream.timing"
# Model-built A2UI surfaces and the server-template cards (confirm, receipt) both count as UI.
SURFACE_ACTIVITIES = frozenset({"a2ui-surface", "bank-template"})


class StreamTimer:
    """One per run. `observe` every event sent to the client, then `finish` once."""

    def __init__(
        self, clock: Callable[[], float] = time.monotonic, tracer: trace.Tracer | None = None, thread_id: str = ""
    ) -> None:
        self._clock = clock
        self._start = clock()
        self._span = (tracer or trace.get_tracer(__name__)).start_span(STREAM_SPAN)
        if thread_id:
            self._span.set_attribute(THREAD_ATTRIBUTE, thread_id)
        self.first_token_ms: float | None = None
        self.first_surface_ms: float | None = None

    def _elapsed_ms(self) -> float:
        return round((self._clock() - self._start) * 1000, 1)

    def observe(self, event: BaseEvent) -> None:
        if self.first_token_ms is None and isinstance(event, TextMessageContentEvent) and event.delta:
            self.first_token_ms = self._elapsed_ms()
        elif (
            self.first_surface_ms is None
            and isinstance(event, ActivitySnapshotEvent)
            and event.activity_type in SURFACE_ACTIVITIES
        ):
            self.first_surface_ms = self._elapsed_ms()

    def finish(self, attributes: Mapping[str, AttributeValue] | None = None) -> None:
        """`attributes` adds what the run's model chains did (`bot.models_served`, `bot.failovers`)."""
        timings = {
            TTFT_ATTRIBUTE: self.first_token_ms,
            FIRST_SURFACE_ATTRIBUTE: self.first_surface_ms,
            DURATION_ATTRIBUTE: self._elapsed_ms(),
        }
        recorded = {name: value for name, value in timings.items() if value is not None}
        self._span.set_attributes({**recorded, **(attributes or {})})
        self._span.end()
        fields = {name.removeprefix("bot."): value for name, value in recorded.items()}
        logger.info("stream timing", extra={"metric": TIMING_METRIC, **fields})
