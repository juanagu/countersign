from typing import Any

from fastapi import APIRouter
from pydantic_ai.conversation_store import ConversationStore

from app.auth.dependencies import CurrentPrincipal
from app.conversations.history import stored_messages, transcript


def conversations_router(store: ConversationStore) -> APIRouter:
    router = APIRouter()

    @router.get("/threads/{thread_id}/messages")
    async def thread_messages(thread_id: str, principal: CurrentPrincipal) -> dict[str, Any]:
        """The caller's own conversation on this thread; another user's thread id reads as empty."""
        return {"messages": transcript(await stored_messages(store, principal.user_id, thread_id))}

    return router
