"""Agent spans carry no customer content: names and memos can't be redacted by pattern (security rule 7)."""

import json
from typing import Any

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.core.telemetry import agent_instrumentation

NAMES = ("Ana Gómez", "Lucía Fernández", "Juan Pérez", "Cena con Lucía")


def _model(messages: list[ModelMessage], _: AgentInfo) -> ModelResponse:
    if not any(isinstance(p, ToolReturnPart) for m in messages for p in getattr(m, "parts", [])):
        return ModelResponse(parts=[ToolCallPart("list_beneficiaries", {"query": "Lucía Fernández"})])
    return ModelResponse(parts=[TextPart("Tus beneficiarios son Ana Gómez y Lucía Fernández.")])


def _span_text(exporter: InMemorySpanExporter) -> str:
    def attributes(span: Any) -> list[Any]:
        return [dict(span.attributes or {}), *[dict(e.attributes or {}) for e in span.events]]

    return json.dumps([attributes(s) for s in exporter.get_finished_spans()], ensure_ascii=False, default=str)


async def test_agent_spans_keep_structure_but_no_names_or_memos() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    agent = Agent(FunctionModel(_model))
    agent.instrument = agent_instrumentation(provider)

    @agent.tool_plain
    def list_beneficiaries(query: str) -> dict[str, Any]:
        return {"beneficiaries": [{"name": "Juan Pérez", "memo": "Cena con Lucía"}]}

    await agent.run("Mostrame a Lucía Fernández, mi beneficiaria")

    text = _span_text(exporter)
    assert "list_beneficiaries" in text  # The structure is still there to debug with.
    assert [name for name in NAMES if name in text] == []
