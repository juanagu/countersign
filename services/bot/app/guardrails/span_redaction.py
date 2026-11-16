"""A span-exporter wrapper that redacts PII and credentials from span attributes, events, links and status."""

import re
from collections.abc import Sequence
from typing import Any

from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import Link, Status
from opentelemetry.util.types import Attributes

from app.guardrails.pii import redact, redact_value
from app.guardrails.stream_timing import RUN_ID_ATTRIBUTE, THREAD_ATTRIBUTE

# The ids are client-supplied (the AG-UI threadId and runId), so only a value shaped like a uuid is kept as is: the
# evals match it against the client's own, and the phone pattern would change its digit groups. Anything else in
# these attributes, or any other attribute, is redacted.
OPAQUE_ID_ATTRIBUTES = frozenset({RUN_ID_ATTRIBUTE, THREAD_ATTRIBUTE})
UUID_SHAPE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def _is_opaque_id(key: str, value: Any) -> bool:
    return key in OPAQUE_ID_ATTRIBUTES and isinstance(value, str) and UUID_SHAPE.fullmatch(value) is not None


def redact_attributes(attributes: Attributes) -> dict[str, Any]:
    return {
        key: value if _is_opaque_id(key, value) else redact_value(value) for key, value in (attributes or {}).items()
    }


def redact_status(status: Status) -> Status:
    """The SDK sets an exception's `"{type}: {message}"` as the description, and messages can quote PII."""
    if status.description is None:
        return status
    return Status(status.status_code, redact(status.description))


def redact_span(span: ReadableSpan) -> ReadableSpan:
    events = [Event(e.name, redact_attributes(e.attributes), e.timestamp) for e in span.events]
    links = [Link(link.context, redact_attributes(link.attributes)) for link in span.links]
    return ReadableSpan(
        name=span.name,
        context=span.context,
        parent=span.parent,
        resource=span.resource,
        attributes=redact_attributes(span.attributes),
        events=events,
        links=links,
        kind=span.kind,
        status=redact_status(span.status),
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
