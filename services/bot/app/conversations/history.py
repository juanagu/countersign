"""The bot's server-owned conversation: its id, what a run continues from, and the transcript a reload shows."""

from collections.abc import Sequence
from copy import deepcopy
from typing import Any

from ag_ui.core import ActivityMessage
from pydantic import BaseModel
from pydantic_ai.conversation_store import ConversationStore
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, ToolReturnPart
from pydantic_ai.ui.ag_ui import AGUIAdapter

from app.core.clock import BankClock
from app.genui.render_ui import RENDER_UI_TOOL
from app.genui.templates import ACTIVITY_TYPE as TEMPLATE_ACTIVITY
from app.guardrails.grounding import Evidence
from app.guardrails.messages import customer_texts
from app.guardrails.output_guard import released_text
from app.skills.history import LOAD_SKILL

TRANSCRIPT_ROLES = frozenset({"user", "assistant"})
# Their results are instructions or UI, not bank data: like in a run (`PolicyToolset`), they ground no figure.
NON_EVIDENCE_TOOLS = frozenset({LOAD_SKILL, RENDER_UI_TOOL})


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

    Tool calls are left out so the client never sees a call it might think is still waiting on it. The stored
    copy is the one before the output guard: answers go through its deterministic checks again (PII, grounding),
    and A2UI surfaces stay out, since the guard may have withheld them.
    """
    shown: list[dict[str, Any]] = []
    grounding = _ReloadEvidence()
    for message in messages:
        shown.extend(_template_cards(message))
        evidence = grounding.for_answer(message) if isinstance(message, ModelResponse) else None
        shown.extend(_texts(message, evidence))
        grounding.read(message)
    return shown


class _ReloadEvidence:
    """What the output guard grounded each answer on, rebuilt from the stored history: the tool results before it,
    the customer's latest message and the bank's day the answer was given."""

    def __init__(self) -> None:
        self._tool_results = Evidence()
        self._latest_prompt = ""

    def read(self, message: ModelMessage) -> None:
        if not isinstance(message, ModelRequest):
            return
        for part in message.parts:
            if isinstance(part, ToolReturnPart) and part.tool_name not in NON_EVIDENCE_TOOLS:
                self._tool_results.add(part.content)
        self._latest_prompt = next(reversed(customer_texts([message])), self._latest_prompt)

    def for_answer(self, response: ModelResponse) -> Evidence:
        evidence = deepcopy(self._tool_results)
        evidence.add_date(BankClock(now=lambda: response.timestamp).today())
        evidence.add_text(self._latest_prompt)
        return evidence


def _texts(message: ModelMessage, evidence: Evidence | None) -> list[dict[str, Any]]:
    texts: list[dict[str, Any]] = []
    for dumped_message in AGUIAdapter.dump_messages([message]):
        dumped = dumped_message.model_dump(by_alias=True, exclude_none=True)
        if dumped.get("role") not in TRANSCRIPT_ROLES or not dumped.get("content"):
            continue
        dumped.pop("toolCalls", None)
        if dumped["role"] == "assistant" and evidence is not None and isinstance(dumped["content"], str):
            dumped["content"] = released_text(dumped["content"], evidence)
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
