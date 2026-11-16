import contextlib
import json
import logging
import sys

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
            "args": ("2850590940090418135201", "ana@example.com"),
            "token": f"Bearer {JWT}",
            "detail": {"account": "0170-0002-7810", "amount": "1254300.50"},
        }
    )
    entry = _format(record)
    assert entry["msg"] == "transfer to [cbu] by [email]"
    assert entry["token"] == "[token]"
    assert entry["detail"] == {"account": "[cuenta]", "amount": "1254300.50"}


def test_opaque_id_attributes_keep_their_value_and_every_other_attribute_is_redacted() -> None:
    uuid_the_phone_pattern_reads = "3f2a9c10-7b1e-4d2a-1234-5678abcdef01"
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(exporter)))
    with provider.get_tracer("t").start_as_current_span("bot.stream") as span:
        span.set_attribute("bot.run_id", uuid_the_phone_pattern_reads)
        span.set_attribute("bot.thread_id", uuid_the_phone_pattern_reads)
        span.set_attribute("cuj.thread_id", uuid_the_phone_pattern_reads)
        span.set_attribute("cuj.discarded_threads", [uuid_the_phone_pattern_reads])
        span.set_attribute("bot.note", uuid_the_phone_pattern_reads)

    attributes = exporter.get_finished_spans()[0].attributes or {}
    assert attributes["bot.run_id"] == attributes["bot.thread_id"] == attributes["cuj.thread_id"]
    assert attributes["bot.run_id"] == uuid_the_phone_pattern_reads
    assert list(attributes["cuj.discarded_threads"]) == [uuid_the_phone_pattern_reads]  # type: ignore[arg-type]
    assert attributes["bot.note"] == "3f2a9c10-7b1e-4d2a-[teléfono]abcdef01"


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
        span.set_attribute("gen_ai.input.messages", json.dumps([{"content": "mi CBU es 2850590940090418135201"}]))
        span.set_attribute("tags", ["ana@example.com", "ok"])
        span.set_attribute("count", 3)
        span.add_event("tool", {"result": "cuenta 0170-0001-4521"})

    [exported] = memory.get_finished_spans()
    assert exported.attributes is not None
    assert "2850590940090418135201" not in str(exported.attributes["gen_ai.input.messages"])
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
        raise ValueError("no hay CBU 2850590940090418135201 para ana@example.com")

    exported = next(span for span in memory.get_finished_spans() if span.name == "chat")
    assert exported.status.status_code is StatusCode.ERROR
    assert exported.status.description == "ValueError: no hay CBU [cbu] para [email]"
    assert exported.links[0].attributes == {"note": "pedido de [email]"}
    assert exported.links[0].context.span_id == earlier.get_span_context().span_id
