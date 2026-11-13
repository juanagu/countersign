from fastapi import APIRouter, Request, Response
from pydantic_ai import Agent
from pydantic_ai.toolsets import AbstractToolset
from pydantic_ai.ui.ag_ui import AGUIAdapter

from app.auth.dependencies import CurrentPrincipal
from app.chat.deps import BotDeps


class BankAGUIAdapter(AGUIAdapter[BotDeps, str]):
    """Ignores tools declared by the client: the browser is untrusted and must not add callable tools."""

    @property
    def toolset(self) -> AbstractToolset[BotDeps] | None:
        return None


def chat_router(agent: Agent[BotDeps, str]) -> APIRouter:
    router = APIRouter()

    @router.post("/agent")
    async def run_agent(request: Request, principal: CurrentPrincipal) -> Response:
        deps = BotDeps(user_id=principal.user_id, access_token=principal.token)
        return await BankAGUIAdapter.dispatch_request(request, agent=agent, deps=deps)

    return router
