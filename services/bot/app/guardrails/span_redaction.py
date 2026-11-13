"""A span-exporter wrapper that redacts PII and credentials from span attributes and events (security rule 7)."""

from collections.abc import Sequence
from typing import Any

from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.util.types import Attributes

from app.guardrails.pii import redact


def _redact_attribute(value: Any) -> Any:
    if isinstance(value, str):
        return redact(value)
    if isinstance(value, Sequence) and not isinstance(value, bytes):
        return tuple(redact(item) if isinstance(item, str) else item for item in value)
    return value


def redact_attributes(attributes: Attributes) -> dict[str, Any]:
    return {key: _redact_attribute(value) for key, value in (attributes or {}).items()}


def redact_span(span: ReadableSpan) -> ReadableSpan:
    events = [Event(e.name, redact_attributes(e.attributes), e.timestamp) for e in span.events]
    return ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=redact_attributes(span.attributes),
        events=events,
        links=span.links,
        kind=span.kind,
        status=span.status,
        start_time=span.start_time,
        end_time=span.end_time,
        instrumentation_scope=span.instrumentation_scope,
    )


class RedactingSpanExporter(SpanExporter):
    """Every span leaves the process redacted, whatever instrumentation produced it."""

    def __init__(self, wrapped: SpanExporter) -> None:
        self._wrapped = wrapped

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        return self._wrapped.export([redact_span(span) for span in spans])

    def shutdown(self) -> None:
        self._wrapped.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._wrapped.force_flush(timeout_millis)
