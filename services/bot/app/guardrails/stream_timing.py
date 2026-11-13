"""How fast one run reached the customer: time to the first text delta and to the first UI surface.

Measured on what leaves the bot, after the input gate and the sentence-by-sentence output guard, so it is the
latency the customer feels. Recorded on a `bot.stream` span and one log line; both carry timings only.
"""

import logging
import time
from collections.abc import Callable

from ag_ui.core import ActivitySnapshotEvent, BaseEvent, TextMessageContentEvent
from opentelemetry import trace

logger = logging.getLogger(__name__)

STREAM_SPAN = "bot.stream"
TTFT_ATTRIBUTE = "bot.time_to_first_token_ms"
FIRST_SURFACE_ATTRIBUTE = "bot.time_to_first_surface_ms"
DURATION_ATTRIBUTE = "bot.stream_duration_ms"
TIMING_METRIC = "bot.stream.timing"
# Model-built A2UI surfaces and the server-template cards (confirm, receipt) both count as UI.
SURFACE_ACTIVITIES = frozenset({"a2ui-surface", "bank-template"})


class StreamTimer:
    """One per run. `observe` every event sent to the client, then `finish` once."""

    def __init__(self, clock: Callable[[], float] = time.monotonic, tracer: trace.Tracer | None = None) -> None:
        self._clock = clock
        self._start = clock()
        self._span = (tracer or trace.get_tracer(__name__)).start_span(STREAM_SPAN)
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

    def finish(self) -> None:
        timings = {
            TTFT_ATTRIBUTE: self.first_token_ms,
            FIRST_SURFACE_ATTRIBUTE: self.first_surface_ms,
            DURATION_ATTRIBUTE: self._elapsed_ms(),
        }
        recorded = {name: value for name, value in timings.items() if value is not None}
        self._span.set_attributes(recorded)
        self._span.end()
        fields = {name.removeprefix("bot."): value for name, value in recorded.items()}
        logger.info("stream timing", extra={"metric": TIMING_METRIC, **fields})
