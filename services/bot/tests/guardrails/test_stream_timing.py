from ag_ui.core import ActivitySnapshotEvent, EventType, TextMessageContentEvent, TextMessageStartEvent
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

from app.guardrails.stream_timing import (
    DURATION_ATTRIBUTE,
    FIRST_SURFACE_ATTRIBUTE,
    STREAM_SPAN,
    TTFT_ATTRIBUTE,
    StreamTimer,
)


class Clock:
    def __init__(self) -> None:
        self.now = 100.0

    def __call__(self) -> float:
        return self.now


def _timer() -> tuple[StreamTimer, Clock, InMemorySpanExporter]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    clock = Clock()
    return StreamTimer(clock, provider.get_tracer("test")), clock, exporter


def _delta(text: str) -> TextMessageContentEvent:
    return TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id="m", delta=text)


def _surface(kind: str) -> ActivitySnapshotEvent:
    return ActivitySnapshotEvent(type=EventType.ACTIVITY_SNAPSHOT, message_id="a", activity_type=kind, content={})


def test_records_the_first_text_and_the_first_surface_on_a_span() -> None:
    timer, clock, exporter = _timer()
    clock.now += 0.5
    timer.observe(TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id="m"))
    timer.observe(_surface("pydantic_ai_tool_availability_delta"))  # not UI
    clock.now += 0.25
    timer.observe(_delta("Hola. "))
    clock.now += 1.0
    timer.observe(_surface("a2ui-surface"))
    timer.observe(_delta("Más."))
    clock.now += 0.25
    timer.finish()

    [span] = exporter.get_finished_spans()
    assert span.name == STREAM_SPAN
    assert span.attributes == {TTFT_ATTRIBUTE: 750.0, FIRST_SURFACE_ATTRIBUTE: 1750.0, DURATION_ATTRIBUTE: 2000.0}


def test_a_run_without_text_or_surface_records_only_its_duration() -> None:
    timer, clock, exporter = _timer()
    timer.observe(_delta(""))
    clock.now += 0.1
    timer.finish()

    [span] = exporter.get_finished_spans()
    assert span.attributes == {DURATION_ATTRIBUTE: 100.0}


def test_a_server_template_card_counts_as_the_first_surface() -> None:
    timer, clock, exporter = _timer()
    clock.now += 2.0
    timer.observe(_surface("bank-template"))
    timer.finish()

    [span] = exporter.get_finished_spans()
    assert span.attributes is not None
    assert span.attributes[FIRST_SURFACE_ATTRIBUTE] == 2000.0


def test_the_span_also_says_which_models_served_and_how_many_failovers() -> None:
    timer, _, exporter = _timer()
    timer.finish({"bot.models_served": ["orchestrator:claude-haiku-5-5"], "bot.failovers": 1})
    [span] = exporter.get_finished_spans()
    assert span.attributes is not None
    assert span.attributes["bot.models_served"] == ("orchestrator:claude-haiku-5-5",)
    assert span.attributes["bot.failovers"] == 1
