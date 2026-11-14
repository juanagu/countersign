"""The store one run saves through: a run whose answer the guard replaced keeps no model output (ADR 015)."""

from collections.abc import Awaitable, Callable, Sequence
from typing import Any

from pydantic_ai.agent import AgentRunResult
from pydantic_ai.conversation import Conversation
from pydantic_ai.conversation_store import ConversationEntry, ConversationRecord, ConversationStore
from pydantic_ai.messages import ModelResponse, TextPart

# The reply the customer got instead of the run's answer, or None when they got the answer.
RefusalShown = Callable[[], Awaitable[str | None]]


class RunConversationStore(ConversationStore):
    """The shared store, except that a refused run is saved as the customer's turn plus the refusal they saw.

    The adapter saves when the run completes, which can be before or after the input verdict, so the save itself
    waits for the verdict: whichever comes first, the model's answer never reaches the stored history.
    """

    def __init__(self, store: ConversationStore, refusal: RefusalShown) -> None:
        self._store = store
        self._refusal = refusal

    async def save(
        self, conversation: Conversation | AgentRunResult[Any], *, scope: str | None = None
    ) -> list[ConversationEntry]:
        refusal = await self._refusal()
        if refusal is None:
            return await self._store.save(conversation, scope=scope)
        if isinstance(conversation, AgentRunResult):
            conversation = conversation.conversation
        if not _replace_run_output(conversation, refusal):
            return []  # Not saved, like a run the block cancelled before it completed.
        return await self._store.save(conversation, scope=scope)

    async def read_record(self, conversation_id: str) -> ConversationRecord | None:
        return await self._store.read_record(conversation_id)

    async def read_records(self, *, scope: str | None = None, limit: int | None = None) -> Sequence[ConversationRecord]:
        return await self._store.read_records(scope=scope, limit=limit)

    async def write_record(
        self,
        record: ConversationRecord,
        *,
        new_entries: Sequence[ConversationEntry] = (),
        expected_revision: str | None,
    ) -> None:
        await self._store.write_record(record, new_entries=new_entries, expected_revision=expected_revision)

    async def delete_record(self, conversation_id: str, *, expected_revision: str) -> None:
        await self._store.delete_record(conversation_id, expected_revision=expected_revision)

    async def read_entry(self, entry_id: str) -> ConversationEntry:
        return await self._store.read_entry(entry_id)

    async def read_history(self, head_id: str | None, *, limit: int | None = None) -> list[ConversationEntry]:
        return await self._store.read_history(head_id, limit=limit)


def _replace_run_output(conversation: Conversation, refusal: str) -> bool:
    """Everything from the run's first model response on becomes the refusal; the turn before it stays.

    In place, so the store still knows which messages it already holds. The run stamps its messages with its id,
    and the last message is the run's; without that id the run's output can't be told apart (False).
    """
    messages = conversation.messages
    run_id = messages[-1].run_id if messages else None
    if run_id is None:
        return False
    first_answer = next(
        (i for i, m in enumerate(messages) if isinstance(m, ModelResponse) and m.run_id == run_id), len(messages)
    )
    messages[first_answer:] = [ModelResponse(parts=[TextPart(content=refusal)], run_id=run_id)]
    conversation.deferred_tool_requests = None
    return True
