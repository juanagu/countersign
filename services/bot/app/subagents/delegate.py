"""The orchestrator's delegate tools: each runs a subagent in this process and hands back its answer as data.

The subagent gets the orchestrator's identity, token and `RunGuard`, but only its own skill; its prompt is built in
code; its answer reaches the orchestrator as untrusted data; and cards, surfaces and grounding evidence cross over
by code from its tool returns, never from its text.
"""

import logging
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from html import escape
from typing import Any

from ag_ui.core import ActivitySnapshotEvent
from opentelemetry import trace
from pydantic_ai import RunContext, Tool, ToolReturn
from pydantic_ai.messages import ModelMessage
from pydantic_ai.run import AgentRunResult
from pydantic_ai.toolsets import FunctionToolset

from app.chat.deps import BotDeps
from app.genui.a2ui import ACTIVITY_TYPE as A2UI_ACTIVITY
from app.genui.render_ui import RENDER_UI_TOOL
from app.genui.templates import ACTIVITY_TYPE as TEMPLATE_ACTIVITY
from app.genui.templates import DEFAULT_TEMPLATES
from app.guardrails.history_guard import grounds_no_figure
from app.guardrails.messages import evidence_record, tool_call_parts, tool_return_parts
from app.guardrails.write_intent import RECENT_MESSAGES
from app.policy.delegate_policy import DelegatePolicyToolset
from app.policy.frequency_caps import FrequencyCaps
from app.policy.policy_toolset import UNTRUSTED_NOTE
from app.policy.risk_tier import RISK_TIER_META_KEY
from app.policy.tool_policy import DRAFT_BOUND_TOOLS, prepared_draft_id
from app.skills.history import skill_load_record
from app.subagents.build import SubagentAgent
from app.subagents.progress import delegation_status
from app.subagents.registry import HandOff, SubagentSpec, delegate_tool_name

logger = logging.getLogger(__name__)

SUBAGENT_RUN_METRIC = "subagent.run"
# Which tool may attach which kind of card: a template card only from a template tool's result (rule 4), a model
# surface only from `render_ui`, which validated it against the catalog in the subagent (rule 5).
FORWARDED_ACTIVITIES: dict[str, frozenset[str]] = {
    TEMPLATE_ACTIVITY: frozenset(DEFAULT_TEMPLATES),
    A2UI_ACTIVITY: frozenset({RENDER_UI_TOOL}),
}
# Written by code and set outside the untrusted wrapper, only on an answer that carries a draft; `{skill}` is the
# spec's `hands_off.skill`, validated at load to grant the draft-bound T3 call.
DRAFT_NEXT_STEP = (
    "The draft's confirmation card is shown and the {skill} skill is loaded. Write one short line without the "
    "card's figures, then call {tools} with the `draft_id` in this answer, in this same turn: the run pauses while "
    "the customer confirms in the app. Never say money was sent unless it returns a receipt."
)


@dataclass(frozen=True)
class Subagent:
    spec: SubagentSpec
    agent: SubagentAgent


def delegate_toolset(subagents: Sequence[Subagent], *, caps: FrequencyCaps) -> DelegatePolicyToolset:
    """One `ask_<name>` tool per subagent, declaring the subagent's ceiling as its tier, behind the delegate gate
    and the conversation's `caps`."""
    tools = [
        Tool(
            _delegate(subagent),
            name=delegate_tool_name(subagent.spec.name),
            description=(
                f"Hand this domain to the {subagent.spec.name} agent: {subagent.spec.description} Write `request` "
                "as one short sentence in your words; it reads the customer's latest messages itself."
            ),
            takes_ctx=True,
            metadata={"meta": {RISK_TIER_META_KEY: subagent.spec.max_tier.name}},
        )
        for subagent in subagents
    ]
    names = frozenset(tool.name for tool in tools)
    return DelegatePolicyToolset(wrapped=FunctionToolset(tools), caps=caps, names=names)


def _delegate(subagent: Subagent) -> Any:
    name, hand_off = subagent.spec.name, subagent.spec.hands_off

    async def delegate(ctx: RunContext[BotDeps], request: str) -> ToolReturn:
        """Runs behind `DelegatePolicyToolset`, which already checked the input verdict and the delegation cap."""
        started = time.monotonic()
        guard = ctx.deps.guard
        # Identity, token, thread and the same RunGuard carry over; skills and unavailable servers don't.
        deps = replace(ctx.deps, loaded_skills={name}, unavailable_servers=set())
        requests_before = ctx.usage.requests
        previous = previous_reply(ctx.messages, delegate_tool_name(name))
        prompt = subagent_prompt(request, guard.customer_messages, previous_reply=previous)
        try:
            result = await _run(subagent.agent, prompt, deps, ctx, tool=delegate_tool_name(name))
        except Exception as error:  # A deferred call (UserError), a model or tool failure: the turn goes on.
            _log_run(name, "failed", started, ctx.usage.requests - requests_before, [], error=error)
            return _answer(name, "failed", reply="", draft_id=None, metadata=None, next_step=None)
        messages = result.new_messages()
        status = "unavailable" if deps.unavailable_servers else "ok"
        _log_run(name, status, started, ctx.usage.requests - requests_before, _tool_names(messages))
        draft_id = last_prepared_draft(messages, hand_off.tool) if hand_off else None
        metadata: list[Any] = [*forwarded_events(messages, hand_off, draft_id), evidence_record(_evidence(messages))]
        next_step = None
        if hand_off and draft_id:
            _hand_off_draft(ctx.deps, metadata, hand_off.skill)
            next_step = draft_next_step(hand_off.skill)
        return _answer(name, status, reply=result.output, draft_id=draft_id, metadata=metadata, next_step=next_step)

    return delegate


async def _run(
    agent: SubagentAgent, prompt: str, deps: BotDeps, ctx: RunContext[BotDeps], *, tool: str
) -> AgentRunResult[str]:
    """Runs the subagent unstreamed, inside one status call named `tool` that the client shows as its progress
    line."""
    async with delegation_status(ctx, tool):
        return await agent.run(prompt, deps=deps, usage=ctx.usage)


def subagent_prompt(request: str, customer_messages: Sequence[str], *, previous_reply: str | None = None) -> str:
    """Built in code: the subagent's own previous reply in this thread, the customer's last redacted messages, then
    the orchestrator's request labelled as its own. Each text is escaped, so none can close its block and forge
    another."""
    recent = "\n".join(f"- {_escaped(message)}" for message in customer_messages[-RECENT_MESSAGES:])
    blocks = [f"<customer_messages>\n{recent}\n</customer_messages>"]
    if previous_reply:
        blocks.insert(0, f"<your_previous_reply>\n{_escaped(previous_reply)}\n</your_previous_reply>")
    blocks.append(f"<orchestrator_request>\n{_escaped(request)}\n</orchestrator_request>")
    return "\n".join(blocks)


def _escaped(text: str) -> str:
    return escape(text, quote=False)


def previous_reply(messages: Sequence[ModelMessage], tool_name: str) -> str | None:
    """The reply in the thread's last `tool_name` return, read by code, so a subagent can resolve an answer to its
    own question ("la segunda")."""
    returns = [part for part in tool_return_parts(messages) if part.tool_name == tool_name]
    content = returns[-1].content if returns else None
    answer = content.get("untrusted_data") if isinstance(content, Mapping) else None
    reply = answer.get("reply") if isinstance(answer, Mapping) else None
    return reply if isinstance(reply, str) and reply else None


def _hand_off_draft(deps: BotDeps, metadata: list[Any], skill: str) -> None:
    """Loads the root `skill` that owns the T3 call on the draft for the rest of this run, whether or not the
    orchestrator's model calls `load_skill`, and records it on the return so a resume's replay loads it too."""
    deps.loaded_skills.add(skill)
    metadata.append(skill_load_record(skill))


def draft_next_step(skill: str) -> str:
    return DRAFT_NEXT_STEP.format(skill=skill, tools=", ".join(f"`{tool}`" for tool in sorted(DRAFT_BOUND_TOOLS)))


def _answer(
    name: str, status: str, *, reply: str, draft_id: str | None, metadata: list[Any] | None, next_step: str | None
) -> ToolReturn:
    """`status`, `draft_id` and `next_step` are set by code; `reply` is the subagent's text, wrapped as untrusted data
    (rule 6)."""
    answer = {"agent": name, "status": status, "reply": reply, "draft_id": draft_id}
    value: dict[str, Any] = {"untrusted_data": answer, "note": UNTRUSTED_NOTE}
    if next_step:
        value["next_step"] = next_step
    return ToolReturn(return_value=value, metadata=metadata)


def forwarded_events(
    messages: Sequence[ModelMessage], hand_off: HandOff | None = None, draft_id: str | None = None
) -> list[ActivitySnapshotEvent]:
    """The cards the subagent's tools attached, each only from a tool allowed to attach its kind. Of the hand-off
    tool's results, only the card of `draft_id`, the draft the answer binds, is shown: an earlier draft's card
    could be confirmed in the app but never executed."""
    events: list[ActivitySnapshotEvent] = []
    for part in tool_return_parts(messages):
        if part.outcome != "success" or not isinstance(part.metadata, list):
            continue
        if hand_off and part.tool_name == hand_off.tool and prepared_draft_id(part.content) != draft_id:
            continue
        for item in part.metadata:
            allowed = FORWARDED_ACTIVITIES.get(item.activity_type) if isinstance(item, ActivitySnapshotEvent) else None
            if allowed and part.tool_name in allowed:
                events.append(item)
    return events


def _evidence(messages: Sequence[ModelMessage]) -> list[tuple[str, Any]]:
    """The subagent's tool results, as they ground figures in a stored history: never its text."""
    return [
        (part.tool_name, part.content) for part in tool_return_parts(messages) if not grounds_no_figure(part.tool_name)
    ]


def last_prepared_draft(messages: Sequence[ModelMessage], tool: str) -> str | None:
    """The draft of the last successful `tool` result: copied by code, never from the subagent's text."""
    drafts = [
        prepared_draft_id(part.content)
        for part in tool_return_parts(messages)
        if part.tool_name == tool and part.outcome == "success"
    ]
    return next((draft for draft in reversed(drafts) if draft), None)


def _tool_names(messages: Sequence[ModelMessage]) -> list[str]:
    return [part.tool_name for part in tool_call_parts(messages)]


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
