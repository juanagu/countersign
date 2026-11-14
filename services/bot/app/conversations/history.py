"""The bot's server-owned conversation: its id, what a run continues from, and the transcript a reload shows."""

from collections.abc import Sequence
from typing import Any

from ag_ui.core import ActivityMessage
from pydantic import BaseModel
from pydantic_ai.conversation_store import ConversationStore
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, ToolReturnPart
from pydantic_ai.ui.ag_ui import AGUIAdapter

from app.genui.templates import ACTIVITY_TYPE as TEMPLATE_ACTIVITY
from app.guardrails.figures import bullet_masks

TRANSCRIPT_ROLES = frozenset({"user", "assistant"})


def conversation_id_for(user_id: str, thread_id: str) -> str:
    """Prefixed with the user, so nobody can take another user's thread id first and lock its owner out."""
    return f"{user_id}:{thread_id}"


def new_turn(client_messages: Sequence[ModelMessage]) -> list[ModelMessage]:
    """The client's messages after its last model response: all a run takes from the client (ADR 015)."""
    last = max((i for i, m in enumerate(client_messages) if isinstance(m, ModelResponse)), default=-1)
    return list(client_messages[last + 1 :])


async def stored_messages(store: ConversationStore, user_id: str, thread_id: str) -> list[ModelMessage]:
    conversation = await store.load(conversation_id_for(user_id, thread_id), scope=user_id)
    return conversation.messages if conversation is not None else []


def transcript(messages: Sequence[ModelMessage]) -> list[dict[str, Any]]:
    """What a reload past the replay window shows: the user's and the assistant's text, plus the server-template
    cards (confirm, receipt), in the order they happened. No tool traffic.

    Tool calls are left out so the client never sees a call it might think is still waiting on it. A2UI surfaces
    stay out too: the stored copy is the one before the output guard, which may have withheld it.
    """
    shown: list[dict[str, Any]] = []
    for message in messages:
        shown.extend(_template_cards(message))
        shown.extend(_texts(message))
    return shown


def _texts(message: ModelMessage) -> list[dict[str, Any]]:
    texts: list[dict[str, Any]] = []
    for dumped_message in AGUIAdapter.dump_messages([message]):
        dumped = dumped_message.model_dump(by_alias=True, exclude_none=True)
        if dumped.get("role") not in TRANSCRIPT_ROLES or not dumped.get("content"):
            continue
        dumped.pop("toolCalls", None)
        if dumped["role"] == "assistant" and isinstance(dumped["content"], str):
            dumped["content"] = bullet_masks(dumped["content"])  # Answers stored before the guard rewrote masks.
        texts.append(dumped)
    return texts


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
