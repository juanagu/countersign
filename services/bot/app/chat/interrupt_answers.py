"""Client tool messages that answer an approval interrupt, which CopilotKit adds to the history before resuming.

CopilotKit's `useInterrupt` `resolve(payload)` appends a `role: "tool"` message for the paused call whose content is
the resume payload, step-up token included, and keeps it in every later request. The resume entry decides the call:
Pydantic AI refuses to override a call that already has a result, and the token must never reach the model.
"""

import json
from collections.abc import Collection, Sequence
from typing import Any

from ag_ui.core import Message, ToolMessage

from app.policy.policy_toolset import APPROVAL_ONLY_ARGS


def carries_approval_credential(content: object) -> bool:
    """True for a resume payload whose `editedArgs` hold an approval-only argument such as the step-up token."""
    if not isinstance(content, str):
        return False  # Content parts: CopilotKit's answer is always the payload as a JSON string.
    try:
        payload: Any = json.loads(content)
    except ValueError:
        return False
    edited = payload.get("editedArgs") if isinstance(payload, dict) else None
    return isinstance(edited, dict) and bool(APPROVAL_ONLY_ARGS & edited.keys())


def _is_interrupt_answer(message: Message, resumed_calls: Collection[str]) -> bool:
    if not isinstance(message, ToolMessage):
        return False
    return message.tool_call_id in resumed_calls or carries_approval_credential(message.content)


def without_interrupt_answers(messages: Sequence[Message], resumed_calls: Collection[str]) -> list[Message]:
    """The client's messages minus answers to the calls this run resumes and any answer carrying a credential.

    An older answer is dropped too: the call's real result follows it, or Pydantic AI marks the call interrupted.
    """
    return [message for message in messages if not _is_interrupt_answer(message, resumed_calls)]
