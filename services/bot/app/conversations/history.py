"""The bot's server-owned conversation: its id, what a run continues from, and the transcript a reload shows."""

from collections.abc import Sequence
from typing import Any

from pydantic_ai.conversation_store import ConversationStore
from pydantic_ai.messages import ModelMessage, ModelResponse
from pydantic_ai.ui.ag_ui import AGUIAdapter

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
    """What a reload past the replay window shows: the user's and the assistant's text, no tool traffic.

    Tool calls are left out so the client never sees a call it might think is still waiting on it.
    """
    shown: list[dict[str, Any]] = []
    for message in AGUIAdapter.dump_messages(messages):
        dumped = message.model_dump(by_alias=True, exclude_none=True)
        if dumped.get("role") not in TRANSCRIPT_ROLES or not dumped.get("content"):
            continue
        dumped.pop("toolCalls", None)
        shown.append(dumped)
    return shown
