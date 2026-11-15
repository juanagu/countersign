"""Reads and redacts the customer's turns in a Pydantic AI message history."""

from collections.abc import Callable, Collection, Iterator, Mapping, Sequence
from dataclasses import replace
from typing import Any

from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelResponse,
    ToolCallPart,
    ToolReturnPart,
    UserPromptPart,
)

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


# A `ToolReturnPart.metadata` item holding the tool results another agent's policy recorded: the root history never
# holds a subagent's own tool returns, only its delegate tool's return.
EVIDENCE_RECORD = "bot-evidence"


def evidence_record(results: Sequence[tuple[str, Any]]) -> dict[str, Any]:
    """(tool name, result content) pairs, as plain JSON so the conversation store keeps them as they are."""
    return {"kind": EVIDENCE_RECORD, "results": [{"tool": tool, "content": content} for tool, content in results]}


def records_on(part: ToolReturnPart, delegates: Collection[str], kind: str) -> Iterator[Mapping[str, Any]]:
    """The `kind` records code put in a tool return's `metadata`, read only on a delegate tool's return: any other
    tool's metadata could be filled by a backend."""
    metadata = part.metadata if part.tool_name in delegates else None
    for item in metadata if isinstance(metadata, list) else ():
        if isinstance(item, Mapping) and item.get("kind") == kind:
            yield item


def _recorded(part: ToolReturnPart, delegates: Collection[str]) -> Iterator[tuple[str, Any]]:
    for record in records_on(part, delegates, EVIDENCE_RECORD):
        for result in record.get("results") or ():
            if isinstance(result, Mapping) and isinstance(result.get("tool"), str):
                yield result["tool"], result.get("content")


def tool_return_parts(messages: Sequence[ModelMessage]) -> Iterator[ToolReturnPart]:
    """Each tool return the messages hold, oldest first."""
    for message in messages:
        for part in message.parts if isinstance(message, ModelRequest) else ():
            if isinstance(part, ToolReturnPart):
                yield part


def tool_call_parts(messages: Sequence[ModelMessage]) -> Iterator[ToolCallPart]:
    """Each tool call the model's responses hold, oldest first."""
    for message in messages:
        for part in message.parts if isinstance(message, ModelResponse) else ():
            if isinstance(part, ToolCallPart):
                yield part


def tool_returns_in(
    messages: Sequence[ModelMessage], *, delegates: Collection[str] = frozenset()
) -> list[tuple[str, Any]]:
    """(tool name, content) for each tool result the history holds, oldest first. `delegates` names the delegate
    tools: the results their evidence record holds follow right after their own return."""
    returns: list[tuple[str, Any]] = []
    for part in tool_return_parts(messages):
        returns.append((part.tool_name, part.content))
        returns.extend(_recorded(part, delegates))
    return returns


def tools_returned_in(messages: Sequence[ModelMessage], *, delegates: Collection[str] = frozenset()) -> set[str]:
    """Names of the tools whose results the history already holds."""
    return {name for name, _ in tool_returns_in(messages, delegates=delegates)}


def tool_results_in(
    messages: Sequence[ModelMessage],
    *,
    excluding: Callable[[str], bool] = lambda _: False,
    delegates: Collection[str] = frozenset(),
) -> list[Any]:
    """The content of each tool result the history holds, oldest first, except those of the excluded tools."""
    return [content for name, content in tool_returns_in(messages, delegates=delegates) if not excluding(name)]


def customer_spoke_since_last_response(messages: Sequence[ModelMessage]) -> bool:
    """True when a customer prompt follows the model's last response, or the model never responded."""
    for message in reversed(messages):
        if isinstance(message, ModelResponse):
            return False
        if any(isinstance(part, UserPromptPart) for part in message.parts):
            return True
    return True
