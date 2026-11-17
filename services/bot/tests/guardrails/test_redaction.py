import contextlib
import json
import logging
import sys

import pytest
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import Link, StatusCode
from uvicorn.logging import AccessFormatter

from app.core.logging import JsonFormatter
from app.guardrails.log_redaction import RedactingFilter
from app.guardrails.span_redaction import RedactingSpanExporter

JWT = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJlLXNpZ24"


def _format(record: logging.LogRecord) -> dict[str, object]:
    RedactingFilter().filter(record)
    return json.loads(JsonFormatter().format(record))  # type: ignore[no-any-return]


def test_log_messages_args_and_extra_fields_are_redacted() -> None:
    record = logging.makeLogRecord(
        {
            "msg": "transfer to %s by %s",
            "args": ("9990000300000000012345", "ana@example.com"),
            "token": f"Bearer {JWT}",
            "detail": {"account": "0170-0002-7810", "amount": "1254300.50"},
        }
    )
    entry = _format(record)
    assert entry["msg"] == "transfer to [cbu] by [email]"
    assert entry["token"] == "[token]"
    assert entry["detail"] == {"account": "[cuenta]", "amount": "1254300.50"}


def _export_attributes(attributes: dict[str, str]) -> dict[str, object]:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(exporter)))
    with provider.get_tracer("t").start_as_current_span("bot.stream") as span:
        for key, value in attributes.items():
            span.set_attribute(key, value)
    return dict(exporter.get_finished_spans()[0].attributes or {})


def test_a_uuid_in_an_id_attribute_is_kept_and_the_same_value_elsewhere_is_redacted() -> None:
    uuid_the_phone_pattern_reads = "3f2a9c10-7b1e-4d2a-1234-5678abcdef01"
    attributes = _export_attributes(
        {"bot.run_id": uuid_the_phone_pattern_reads, "bot.thread_id": uuid_the_phone_pattern_reads,
         "bot.note": uuid_the_phone_pattern_reads}
    )  # fmt: skip
    assert attributes["bot.run_id"] == attributes["bot.thread_id"] == uuid_the_phone_pattern_reads
    assert attributes["bot.note"] == "3f2a9c10-7b1e-4d2a-[teléfono]abcdef01"


@pytest.mark.parametrize(
    "client_value", ["ana@example.com", "dni 30123456", "3f2a9c10-7b1e-4d2a-1234-5678abcdef01 ana@example.com"]
)
def test_a_client_supplied_id_that_is_not_a_uuid_is_redacted(client_value: str) -> None:
    attributes = _export_attributes({"bot.run_id": client_value, "bot.thread_id": client_value})
    assert attributes["bot.run_id"] == attributes["bot.thread_id"] != client_value
    assert "ana@example.com" not in str(attributes) and "30123456" not in str(attributes)


def test_an_access_log_record_keeps_its_args_for_uvicorn_and_has_its_path_masked() -> None:
    args = ("127.0.0.1:52100", "GET", "/agent?email=ana@example.com", "1.1", 200)
    record = logging.LogRecord("uvicorn.access", logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d', args, None)
    RedactingFilter().filter(record)
    # Raises on a record whose args were collapsed; logging would print "--- Logging error ---" instead.
    line = AccessFormatter(fmt="%(client_addr)s - %(request_line)s %(status_code)s", use_colors=False).format(record)
    assert line == "127.0.0.1:52100 - GET /agent?email=[email] HTTP/1.1 200 OK"


def test_pii_in_a_non_string_arg_is_still_redacted() -> None:
    record = logging.makeLogRecord({"msg": "dni %d", "args": (30123456,)})
    assert _format(record)["msg"] == "dni [dni]"


def test_exception_text_is_redacted() -> None:
    try:
        raise ValueError("bad card 4532 0151 1283 0366")
    except ValueError:
        record = logging.LogRecord("x", logging.ERROR, __file__, 1, "failed", None, sys.exc_info())
    entry = _format(record)
    assert "4532" not in str(entry["exc"])
    assert "[tarjeta]" in str(entry["exc"])


def test_spans_are_redacted_before_export() -> None:
    memory = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(memory)))
    tracer = provider.get_tracer("test")
    with tracer.start_as_current_span("chat") as span:
        span.set_attribute("gen_ai.input.messages", json.dumps([{"content": "mi CBU es 9990000300000000012345"}]))
        span.set_attribute("tags", ["ana@example.com", "ok"])
        span.set_attribute("count", 3)
        span.add_event("tool", {"result": "cuenta 0170-0001-4521"})

    [exported] = memory.get_finished_spans()
    assert exported.attributes is not None
    assert "9990000300000000012345" not in str(exported.attributes["gen_ai.input.messages"])
    assert exported.attributes["tags"] == ("[email]", "ok")
    assert exported.attributes["count"] == 3
    assert exported.events[0].attributes == {"result": "cuenta [cuenta]"}
    assert exported.context.span_id == span.get_span_context().span_id


def test_a_failed_spans_status_and_its_link_attributes_are_redacted() -> None:
    memory = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(memory)))
    tracer = provider.get_tracer("test")
    with tracer.start_as_current_span("earlier") as earlier:
        pass
    link = Link(earlier.get_span_context(), {"note": "pedido de ana@example.com"})
    with contextlib.suppress(ValueError), tracer.start_as_current_span("chat", links=[link]):
        raise ValueError("no hay CBU 9990000300000000012345 para ana@example.com")

    exported = next(span for span in memory.get_finished_spans() if span.name == "chat")
    assert exported.status.status_code is StatusCode.ERROR
    assert exported.status.description == "ValueError: no hay CBU [cbu] para [email]"
    assert exported.links[0].attributes == {"note": "pedido de [email]"}
    assert exported.links[0].context.span_id == earlier.get_span_context().span_id
