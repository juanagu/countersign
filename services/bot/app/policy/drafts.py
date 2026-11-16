"""The one draft `execute_transfer` may name: read by code from the conversation's messages."""

import json
from collections.abc import Collection, Mapping, Sequence
from typing import Any

from pydantic_ai.messages import ModelMessage, ToolCallPart, ToolReturnPart

from app.guardrails.messages import tool_call_parts, tool_return_parts, tool_returns_in
from app.policy.tool_policy import DRAFT_BOUND_TOOLS, PREPARE_TRANSFER, prepared_draft_id

# Refusals raised by the bot before anything reached the bank: its own policy denial, and an approved call whose
# token or session could not be set up. Neither decides the draft, so the customer can ask again.
UNSENT_ERRORS = frozenset({"policy_denied", "service_unavailable"})
# Answers from mcp-payments that leave the draft pending (ADR 023): `token_already_used` means the step-up token was
# spent and nothing moved with it, `execution_in_progress` that another call still holds the draft and nothing was
# spent. Every other answer from the bank decides the draft.
UNDECIDING_BANK_ERRORS = frozenset({"token_already_used", "execution_in_progress"})
_UNDECIDING_ERRORS = UNSENT_ERRORS | UNDECIDING_BANK_ERRORS


def open_draft(messages: Sequence[ModelMessage], *, delegates: Collection[str] = frozenset()) -> str | None:
    """The draft of the latest `prepare_transfer` result, unless an `execute_transfer` result already decided it:
    a receipt, the customer's denial or cancel, an answer from the bank about it (expired, not pending, insufficient
    funds), or a result Pydantic AI synthesized for a call a cut-off run left open. A newer draft supersedes every
    older one, so at most one draft is open. An error in `UNSENT_ERRORS` (the bot's refusal before anything was sent)
    or in `UNDECIDING_BANK_ERRORS` (the bank's `token_already_used` and `execution_in_progress`: the draft is still
    pending), a retried call and an interrupt nobody answered leave it open, so asking again pauses on it again, and
    the approval needs a fresh step-up token: the spent one is never sent twice.
    `delegates` names the delegate tools whose evidence records hold a subagent's `prepare_transfer` results."""
    drafts = [
        draft
        for name, content in tool_returns_in(messages, delegates=delegates)
        if name == PREPARE_TRANSFER and (draft := prepared_draft_id(content))
    ]
    if not drafts or drafts[-1] in _decided_drafts(messages):
        return None
    return drafts[-1]


def _decided_drafts(messages: Sequence[ModelMessage]) -> set[str]:
    """The drafts named by a draft-bound call whose result decides it, by its arguments or by its result's own
    `draft_id`."""
    calls = {call.tool_call_id: call for call in tool_call_parts(messages) if call.tool_name in DRAFT_BOUND_TOOLS}
    decided: set[str] = set()
    for result in tool_return_parts(messages):
        if result.tool_name not in DRAFT_BOUND_TOOLS or not _decides(result):
            continue
        call = calls.get(result.tool_call_id)
        named = [_draft_named_by(call) if call else None, prepared_draft_id(result.content)]
        decided.update(draft for draft in named if draft)
    return decided


def _decides(result: ToolReturnPart) -> bool:
    """A retried call never ran; anything else decides unless its error leaves the draft pending."""
    return result.outcome != "retried" and _error_code(result.content) not in _UNDECIDING_ERRORS


def _error_code(content: Any) -> str | None:
    """The top-level `error` of a result: the bot's own policy denial (a dict), or the JSON string of a failed call,
    which carries the bank's `isError` text (`{"error": ..., "message": ...}`) as well as the bot's own failures.
    Never read inside `untrusted_data`, which a backend fills. A backend that writes an undeciding code
    can at worst keep a draft open: every execution still needs the customer's fresh single-use step-up token bound
    to that draft (rule 3)."""
    if isinstance(content, str):
        try:
            content = json.loads(content)
        except ValueError:
            return None
    error = content.get("error") if isinstance(content, Mapping) else None
    return error if isinstance(error, str) else None


def _draft_named_by(call: ToolCallPart) -> str | None:
    try:
        draft = call.args_as_dict().get("draft_id")
    except ValueError:
        return None
    return draft if isinstance(draft, str) else None
