from fastapi import APIRouter, Request, Response
from pydantic_ai import Agent
from pydantic_ai.ui.ag_ui import AGUIAdapter

from app.auth.dependencies import CurrentPrincipal
from app.chat.agent import BotDeps


def chat_router(agent: Agent[BotDeps, str]) -> APIRouter:
    router = APIRouter()

    @router.post("/agent")
    async def run_agent(request: Request, principal: CurrentPrincipal) -> Response:
        deps = BotDeps(user_id=principal.user_id, access_token=principal.token)
        return await AGUIAdapter.dispatch_request(request, agent=agent, deps=deps)

    return router
