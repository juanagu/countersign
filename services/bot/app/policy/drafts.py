"""The one draft `execute_transfer` may name: read by code from the conversation's messages."""

from collections.abc import Collection, Sequence

from pydantic_ai.messages import ModelMessage, ToolCallPart, ToolReturnPart

from app.guardrails.messages import tool_returns_in
from app.policy.tool_policy import DRAFT_BOUND_TOOLS, PREPARE_TRANSFER, prepared_draft_id


def open_draft(messages: Sequence[ModelMessage], *, delegates: Collection[str] = frozenset()) -> str | None:
    """The draft of the latest `prepare_transfer` result, unless an `execute_transfer` result already decided it:
    a receipt, a denial, or a result Pydantic AI synthesized for a call a cut-off run left open. A newer draft
    supersedes every older one, so at most one draft is open; an interrupt nobody answered leaves it open, so asking
    again pauses on it again. `delegates` names the delegate tools whose evidence records hold a subagent's
    `prepare_transfer` results."""
    drafts = [
        draft
        for name, content in tool_returns_in(messages, delegates=delegates)
        if name == PREPARE_TRANSFER and (draft := prepared_draft_id(content))
    ]
    if not drafts or drafts[-1] in _decided_drafts(messages):
        return None
    return drafts[-1]


def _decided_drafts(messages: Sequence[ModelMessage]) -> set[str]:
    """The drafts named by a draft-bound call that has a result, by its arguments or by its result's own `draft_id`."""
    calls: dict[str, ToolCallPart] = {}
    results: list[ToolReturnPart] = []
    for message in messages:
        for part in message.parts:
            if isinstance(part, ToolCallPart) and part.tool_name in DRAFT_BOUND_TOOLS:
                calls[part.tool_call_id] = part
            elif isinstance(part, ToolReturnPart) and part.tool_name in DRAFT_BOUND_TOOLS:
                results.append(part)
    decided: set[str] = set()
    for result in results:
        call = calls.get(result.tool_call_id)
        named = [_draft_named_by(call) if call else None, prepared_draft_id(result.content)]
        decided.update(draft for draft in named if draft)
    return decided


def _draft_named_by(call: ToolCallPart) -> str | None:
    try:
        draft = call.args_as_dict().get("draft_id")
    except ValueError:
        return None
    return draft if isinstance(draft, str) else None
