"""The guards still fail closed when their whole chain fails, and failover spans carry no error text (rule 7)."""

import json
from typing import Any

from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic_ai import Agent
from pydantic_ai.exceptions import ModelOverloadedError, ModelServerError

from app.core.llm.run_record import start_run_record
from app.core.telemetry import agent_instrumentation
from app.guardrails.input_classifier import SAFE_REPLIES, GuardModelClassifier
from app.guardrails.span_redaction import RedactingSpanExporter
from app.guardrails.write_intent import GuardModelWriteIntent
from tests.core.llm.fakes import PII_ERROR, Fake, chain


def _overloaded(name: str) -> Exception:
    return ModelOverloadedError(name, PII_ERROR)


async def test_the_input_guard_blocks_when_every_guard_model_fails() -> None:
    guard = chain(Fake("guard-a", error=_overloaded), Fake("guard-b", error=_overloaded), role="guard")
    verdict = await GuardModelClassifier(guard)("¿Cuánto tengo?", "ana")
    assert verdict.blocked
    assert verdict.category == "error"
    assert verdict.text == SAFE_REPLIES["error"]


async def test_the_input_guard_blocks_when_every_guard_model_stalls() -> None:
    guard = chain(Fake("guard-a", stall=True), Fake("guard-b", stall=True), role="guard")
    assert (await GuardModelClassifier(guard)("¿Cuánto tengo?", "ana")).blocked


async def test_the_write_intent_check_denies_when_every_guard_model_fails() -> None:
    guard = chain(Fake("guard-a", error=_overloaded), Fake("guard-b", error=_overloaded), role="guard")
    verdict = await GuardModelWriteIntent(guard)(["mandale 50.000 a Ana"], "prepare_transfer", {"amount": 50000})
    assert verdict.blocked


def _exported_text(spans: tuple[ReadableSpan, ...]) -> str:
    def parts(span: ReadableSpan) -> list[Any]:
        events = [[e.name, dict(e.attributes or {})] for e in span.events]
        return [span.name, dict(span.attributes or {}), events, span.status.description]

    return json.dumps([parts(s) for s in spans], ensure_ascii=False, default=str)


async def test_failover_spans_carry_neither_the_error_message_nor_its_names() -> None:
    exported = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(RedactingSpanExporter(exported)))
    start_run_record()
    agent = Agent(chain(Fake("primary", error=lambda name: ModelServerError(name, PII_ERROR)), Fake("backup")))
    agent.instrument = agent_instrumentation(provider)

    await agent.run("hola")

    text = _exported_text(exported.get_finished_spans())
    assert "primary" in text  # The failed attempt is still there to debug with.
    assert "Lucía" not in text and "30.123.456" not in text and "juan.perez" not in text
