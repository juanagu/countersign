"""The orchestrator's `ask_<name>` tools: each runs a subagent in this process and hands back its answer as data.

ADR 021 §2 and §5: the subagent gets the orchestrator's identity, token and `RunGuard`, but only its own skill; its
prompt is built in code; its answer reaches the orchestrator as untrusted data; and cards, surfaces and grounding
evidence cross over by code from its tool returns, never from its text.
"""

import logging
import time
from collections.abc import Sequence
from dataclasses import dataclass, replace
from typing import Any

from ag_ui.core import ActivitySnapshotEvent
from opentelemetry import trace
from pydantic_ai import RunContext, Tool, ToolReturn
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, ToolCallPart, ToolReturnPart
from pydantic_ai.toolsets import FunctionToolset

from app.chat.deps import BotDeps
from app.genui.render_ui import RENDER_UI_TOOL
from app.genui.templates import ACTIVITY_TYPE as TEMPLATE_ACTIVITY
from app.genui.templates import DEFAULT_TEMPLATES
from app.guardrails.history_guard import grounds_no_figure
from app.guardrails.messages import evidence_record
from app.guardrails.output_guard import A2UI_ACTIVITY
from app.guardrails.write_intent import RECENT_MESSAGES
from app.policy.policy_toolset import UNTRUSTED_NOTE
from app.policy.tool_policy import PREPARE_TRANSFER, prepared_draft_id
from app.skills.registry import Skill
from app.subagents.build import SubagentAgent
from app.subagents.registry import delegate_tool_name

logger = logging.getLogger(__name__)

SUBAGENT_RUN_METRIC = "subagent.run"
BLOCKED = {"error": "policy_denied", "reason": "the customer's message did not pass the input check"}
# Which tool may attach which kind of card: a template card only from a template tool's result (rule 4), a model
# surface only from `render_ui`, which validated it against the catalog in the subagent (rule 5).
FORWARDED_ACTIVITIES: dict[str, frozenset[str]] = {
    TEMPLATE_ACTIVITY: frozenset(DEFAULT_TEMPLATES),
    A2UI_ACTIVITY: frozenset({RENDER_UI_TOOL}),
}


@dataclass(frozen=True)
class Subagent:
    spec: Skill
    agent: SubagentAgent


def delegate_toolset(subagents: Sequence[Subagent]) -> FunctionToolset[BotDeps]:
    tools = [
        Tool(
            _delegate(subagent),
            name=delegate_tool_name(subagent.spec.name),
            description=(
                f"Hand this domain to the {subagent.spec.name} agent: {subagent.spec.description} Write `request` "
                "as one short sentence in your words; it reads the customer's latest messages itself."
            ),
            takes_ctx=True,
        )
        for subagent in subagents
    ]
    return FunctionToolset(tools)


def _delegate(subagent: Subagent) -> Any:
    name = subagent.spec.name

    async def delegate(ctx: RunContext[BotDeps], request: str) -> ToolReturn | dict[str, str]:
        started = time.monotonic()
        guard = ctx.deps.guard
        if (await guard.input_verdict()).blocked:
            return BLOCKED  # A blocked message starts no subagent and spends no tokens on one.
        # Identity, token, thread and the same RunGuard carry over; skills and unavailable servers don't.
        deps = replace(ctx.deps, loaded_skills={name}, unavailable_servers=set())
        requests_before = ctx.usage.requests
        try:
            result = await subagent.agent.run(
                subagent_prompt(request, guard.customer_messages), deps=deps, usage=ctx.usage
            )
        except Exception as error:  # A deferred call (UserError), a model or tool failure: the turn goes on.
            _log_run(name, "failed", started, ctx.usage.requests - requests_before, [], error=error)
            return _answer(name, "failed", reply="", draft_id=None, metadata=None)
        messages = result.new_messages()
        status = "unavailable" if deps.unavailable_servers else "ok"
        _log_run(name, status, started, ctx.usage.requests - requests_before, _tool_names(messages))
        metadata: list[Any] = [*forwarded_events(messages), evidence_record(_evidence(messages))]
        return _answer(name, status, reply=result.output, draft_id=last_prepared_draft(messages), metadata=metadata)

    return delegate


def subagent_prompt(request: str, customer_messages: Sequence[str]) -> str:
    """Built in code: the customer's last redacted messages, then the orchestrator's request labelled as its own."""
    recent = "\n".join(f"- {message}" for message in customer_messages[-RECENT_MESSAGES:])
    return (
        f"<customer_messages>\n{recent}\n</customer_messages>\n"
        f"<orchestrator_request>\n{request}\n</orchestrator_request>"
    )


def _answer(name: str, status: str, *, reply: str, draft_id: str | None, metadata: list[Any] | None) -> ToolReturn:
    """`status` and `draft_id` are set by code; `reply` is the subagent's text, wrapped as untrusted data (rule 6)."""
    answer = {"agent": name, "status": status, "reply": reply, "draft_id": draft_id}
    return ToolReturn(return_value={"untrusted_data": answer, "note": UNTRUSTED_NOTE}, metadata=metadata)


def _tool_returns(messages: Sequence[ModelMessage]) -> list[ToolReturnPart]:
    return [
        part
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    ]


def forwarded_events(messages: Sequence[ModelMessage]) -> list[ActivitySnapshotEvent]:
    """The cards the subagent's tools attached, each only from a tool allowed to attach its kind."""
    events: list[ActivitySnapshotEvent] = []
    for part in _tool_returns(messages):
        if part.outcome != "success" or not isinstance(part.metadata, list):
            continue
        for item in part.metadata:
            allowed = FORWARDED_ACTIVITIES.get(item.activity_type) if isinstance(item, ActivitySnapshotEvent) else None
            if allowed and part.tool_name in allowed:
                events.append(item)
    return events


def _evidence(messages: Sequence[ModelMessage]) -> list[tuple[str, Any]]:
    """The subagent's tool results, as they ground figures in a stored history: never its text."""
    return [(part.tool_name, part.content) for part in _tool_returns(messages) if not grounds_no_figure(part.tool_name)]


def last_prepared_draft(messages: Sequence[ModelMessage]) -> str | None:
    """The draft of the last successful `prepare_transfer` result: copied by code, never from the subagent's text."""
    drafts = [
        prepared_draft_id(part.content)
        for part in _tool_returns(messages)
        if part.tool_name == PREPARE_TRANSFER and part.outcome == "success"
    ]
    return next((draft for draft in reversed(drafts) if draft), None)


def _tool_names(messages: Sequence[ModelMessage]) -> list[str]:
    return [
        part.tool_name
        for message in messages
        if isinstance(message, ModelResponse)
        for part in message.parts
        if isinstance(part, ToolCallPart)
    ]


def _trace_id() -> str | None:
    context = trace.get_current_span().get_span_context()
    return format(context.trace_id, "032x") if context.is_valid else None


def _log_run(
    name: str, status: str, started: float, requests: int, tools: list[str], error: Exception | None = None
) -> None:
    """Never the request, the reply or any argument: they are model and customer text (rule 7)."""
    fields: dict[str, Any] = {
        "metric": SUBAGENT_RUN_METRIC,
        "agent": name,
        "status": status,
        "duration_ms": round((time.monotonic() - started) * 1000, 1),
        "requests": requests,
        "tools": tools,
        "trace_id": _trace_id(),
    }
    if error is not None:
        fields["error"] = type(error).__name__  # The type only: a message can quote model or customer text.
    log = logger.warning if status == "failed" else logger.info
    log("subagent run", extra=fields)
