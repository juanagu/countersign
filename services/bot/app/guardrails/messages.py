"""Reads and redacts the customer's turns in a Pydantic AI message history."""

from collections.abc import Sequence
from dataclasses import replace
from typing import Any

from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, ToolReturnPart, UserPromptPart

from app.guardrails.pii import redact


def _redact_part(part: UserPromptPart) -> UserPromptPart:
    if isinstance(part.content, str):
        return replace(part, content=redact(part.content))
    return replace(part, content=[redact(item) if isinstance(item, str) else item for item in part.content])


def redact_customer_turns(messages: Sequence[ModelMessage]) -> list[ModelMessage]:
    """The history with PII masked in every customer prompt, before the model, logs or traces see it."""
    redacted: list[ModelMessage] = []
    for message in messages:
        if isinstance(message, ModelRequest):
            parts = [_redact_part(p) if isinstance(p, UserPromptPart) else p for p in message.parts]
            message = replace(message, parts=parts)
        redacted.append(message)
    return redacted


def customer_texts(messages: Sequence[ModelMessage]) -> list[str]:
    """The text of each customer prompt, oldest first."""
    texts: list[str] = []
    for message in messages:
        for part in message.parts if isinstance(message, ModelRequest) else ():
            if not isinstance(part, UserPromptPart):
                continue
            content = (
                part.content
                if isinstance(part.content, str)
                else " ".join(item for item in part.content if isinstance(item, str))
            )
            if content.strip():
                texts.append(content)
    return texts


def tools_returned_in(messages: Sequence[ModelMessage]) -> set[str]:
    """Names of the tools whose results the history already holds."""
    return {
        part.tool_name
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart)
    }


def tool_results_in(messages: Sequence[ModelMessage], *, excluding: frozenset[str] = frozenset()) -> list[Any]:
    """The content of each tool result the history holds, oldest first, except the excluded tools'."""
    return [
        part.content
        for message in messages
        if isinstance(message, ModelRequest)
        for part in message.parts
        if isinstance(part, ToolReturnPart) and part.tool_name not in excluding
    ]


def customer_spoke_since_last_response(messages: Sequence[ModelMessage]) -> bool:
    """True when a customer prompt follows the model's last response, or the model never responded."""
    for message in reversed(messages):
        if isinstance(message, ModelResponse):
            return False
        if any(isinstance(part, UserPromptPart) for part in message.parts):
            return True
    return True
