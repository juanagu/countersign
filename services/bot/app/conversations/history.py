"""The bot's server-owned conversation: its id, what a run continues from, and the transcript a reload shows."""

from collections.abc import Collection, Sequence
from dataclasses import dataclass, replace
from typing import Any, TypeGuard

from ag_ui.core import ActivityMessage
from pydantic import BaseModel
from pydantic_ai.conversation_store import ConversationStore
from pydantic_ai.messages import (
    ModelMessage,
    ModelRequest,
    ModelRequestPart,
    ModelResponse,
    RetryPromptPart,
    ToolReturnPart,
)
from pydantic_ai.ui.ag_ui import AGUIAdapter

from app.core.clock import BankClock
from app.genui.templates import ACTIVITY_TYPE as TEMPLATE_ACTIVITY
from app.guardrails.history_guard import StoredAnswers

TRANSCRIPT_ROLES = frozenset({"user", "assistant"})


@dataclass(frozen=True)
class StoredThread:
    messages: list[ModelMessage]
    awaiting_results: frozenset[str]  # Tool calls the conversation waits on a result for, not on an approval.


def conversation_id_for(user_id: str, thread_id: str) -> str:
    """Prefixed with the user, so nobody can take another user's thread id first and lock its owner out."""
    return f"{user_id}:{thread_id}"


def new_turn(client_messages: Sequence[ModelMessage], *, awaiting_results: Collection[str]) -> list[ModelMessage]:
    """The client's requests after its last model response, as the run takes them (ADR 015).

    A tool result is kept only for a call the stored conversation awaits one for, so a client-built result never
    becomes grounding evidence or third-party text (rule 6). Interrupt answers arrive as `resume` entries instead.
    """
    last = max((i for i, m in enumerate(client_messages) if isinstance(m, ModelResponse)), default=-1)
    turn: list[ModelMessage] = []
    for message in client_messages[last + 1 :]:
        if not isinstance(message, ModelRequest):
            continue
        parts = [p for p in message.parts if not _is_tool_result(p) or p.tool_call_id in awaiting_results]
        if parts:
            turn.append(message if len(parts) == len(message.parts) else replace(message, parts=parts))
    return turn


def _is_tool_result(part: ModelRequestPart) -> TypeGuard[ToolReturnPart | RetryPromptPart]:
    return isinstance(part, ToolReturnPart) or (isinstance(part, RetryPromptPart) and part.tool_name is not None)


async def load_thread(store: ConversationStore, user_id: str, thread_id: str) -> StoredThread:
    conversation = await store.load(conversation_id_for(user_id, thread_id), scope=user_id)
    if conversation is None:
        return StoredThread(messages=[], awaiting_results=frozenset())
    waiting = conversation.deferred_tool_requests
    awaiting = frozenset(call.tool_call_id for call in waiting.calls) if waiting is not None else frozenset()
    return StoredThread(messages=conversation.messages, awaiting_results=awaiting)


async def stored_messages(store: ConversationStore, user_id: str, thread_id: str) -> list[ModelMessage]:
    return (await load_thread(store, user_id, thread_id)).messages


def transcript(messages: Sequence[ModelMessage], *, clock: BankClock) -> list[dict[str, Any]]:
    """What a reload past the replay window shows: the user's and the assistant's text, plus the server-template
    cards (confirm, receipt), in the order they happened. No tool traffic.

    Tool calls are left out so the client never sees a call it might think is still waiting on it. The stored
    copy is the one before the output guard: answers go through its deterministic checks again (PII, grounding
    on the bank's day by `clock`), and A2UI surfaces stay out, since the guard may have withheld them.
    """
    shown: list[dict[str, Any]] = []
    answers = StoredAnswers(clock)
    for message in messages:
        shown.extend(_template_cards(message))
        shown.extend(_texts(message, answers))
        answers.read(message)
    return shown


def _texts(message: ModelMessage, answers: StoredAnswers) -> list[dict[str, Any]]:
    texts: list[dict[str, Any]] = []
    for dumped_message in AGUIAdapter.dump_messages([message]):
        dumped = dumped_message.model_dump(by_alias=True, exclude_none=True)
        if dumped.get("role") not in TRANSCRIPT_ROLES or not dumped.get("content"):
            continue
        dumped.pop("toolCalls", None)
        if dumped["role"] == "assistant" and isinstance(message, ModelResponse) and isinstance(dumped["content"], str):
            dumped["content"] = answers.released(dumped["content"], message)
        texts.append(dumped)
    return [text for text in texts if text["content"]]


def _template_cards(message: ModelMessage) -> list[dict[str, Any]]:
    """The cards code built from tool results, kept on the stored tool return exactly as they were streamed."""
    if not isinstance(message, ModelRequest):
        return []
    cards: list[dict[str, Any]] = []
    for part in message.parts:
        if not isinstance(part, ToolReturnPart) or not isinstance(part.metadata, list):
            continue
        for event in part.metadata:
            fields = event.model_dump() if isinstance(event, BaseModel) else event
            if not isinstance(fields, dict) or fields.get("activity_type") != TEMPLATE_ACTIVITY:
                continue
            card = ActivityMessage(
                id=str(fields["message_id"]), activity_type=TEMPLATE_ACTIVITY, content=fields["content"]
            )
            cards.append(card.model_dump(by_alias=True, exclude_none=True))
    return cards
