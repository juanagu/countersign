"""A policy denial is a normal tool result, so its span ends OK: a flag on the span is how a trace tells it apart."""

import json

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.toolsets import FunctionToolset

from app.chat.agent import build_agent
from app.chat.deps import BotDeps
from app.core.telemetry import agent_instrumentation
from app.policy.policy_toolset import POLICY_DENIED_ATTRIBUTE, denied
from app.skills.registry import SkillRegistry
from tests.conftest import TEST_SKILLS_DIR, open_guard

TOOL = "execute_transfer"


async def test_a_denied_calls_tool_span_carries_the_flag_and_an_allowed_one_does_not() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    toolset: FunctionToolset[BotDeps] = FunctionToolset()

    @toolset.tool_plain(metadata={"meta": {"bank/riskTier": "T1"}})
    def list_beneficiaries(step_up_token: str = "") -> str:
        return "ok"

    def respond(messages: list[ModelMessage], _: AgentInfo) -> ModelResponse:
        returns = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
        if not returns:
            return ModelResponse(parts=[ToolCallPart("load_skill", {"name": "payments"})])
        if len(returns) == 1:
            return ModelResponse(parts=[ToolCallPart("list_beneficiaries", {"step_up_token": "forged"})])
        return ModelResponse(parts=[TextPart(json.dumps(returns[-1].content))])

    agent = build_agent(FunctionModel(respond), skills=SkillRegistry.from_dir(TEST_SKILLS_DIR), domain_tools=[toolset])
    agent.instrument = agent_instrumentation(provider)  # type: ignore[attr-defined]
    deps = BotDeps(user_id="juan", access_token="", loaded_skills=set(), guard=open_guard())

    await agent.run("x", deps=deps)

    flagged = {
        s.attributes["gen_ai.tool.name"]: s.attributes.get(POLICY_DENIED_ATTRIBUTE)
        for s in exporter.get_finished_spans()
        if s.attributes and "gen_ai.tool.name" in s.attributes
    }
    assert flagged["list_beneficiaries"] is True
    assert not flagged["load_skill"]


def test_a_denial_flags_only_the_tool_s_own_span() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tracer = provider.get_tracer("t")

    with tracer.start_as_current_span("agent run"):
        denied(TOOL, "not allowed")
        with tracer.start_as_current_span("execute_tool", attributes={"gen_ai.tool.name": TOOL}):
            denied(TOOL, "not allowed")

    flagged = {
        s.name: s.attributes.get(POLICY_DENIED_ATTRIBUTE)
        for s in exporter.get_finished_spans()
        if s.attributes is not None
    }
    assert flagged == {"agent run": None, "execute_tool": True}


def test_a_recording_span_the_sdk_cannot_read_is_reported_instead_of_silently_unflagged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class OpaqueSpan(trace.NonRecordingSpan):
        def is_recording(self) -> bool:
            return True

    with caplog.at_level("WARNING"), trace.use_span(OpaqueSpan(trace.INVALID_SPAN_CONTEXT)):
        denied(TOOL, "not allowed")

    assert "policy denial not flagged" in caplog.text
