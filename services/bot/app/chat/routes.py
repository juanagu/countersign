from fastapi import APIRouter, Request, Response
from pydantic_ai import DeferredToolRequests
from pydantic_ai.toolsets import AbstractToolset
from pydantic_ai.ui.ag_ui import AGUIAdapter

from app.auth.dependencies import CurrentPrincipal
from app.chat.agent import BotAgent
from app.chat.deps import BotDeps
from app.skills.history import skills_loaded_in
from app.skills.registry import SkillRegistry


class BankAGUIAdapter(AGUIAdapter[BotDeps, str | DeferredToolRequests]):
    """Ignores tools declared by the client: the browser is untrusted and must not add callable tools."""

    @property
    def toolset(self) -> AbstractToolset[BotDeps] | None:
        return None


def chat_router(agent: BotAgent, skills: SkillRegistry) -> APIRouter:
    router = APIRouter()

    @router.post("/agent")
    async def run_agent(request: Request, principal: CurrentPrincipal) -> Response:
        body = await request.json()  # Starlette caches it; the adapter reads the same body.
        messages = body.get("messages") if isinstance(body, dict) else None
        restored = skills_loaded_in(messages if isinstance(messages, list) else [])
        deps = BotDeps(
            user_id=principal.user_id,
            access_token=principal.token,
            loaded_skills={name for name in restored if skills.get(name)},
        )
        return await BankAGUIAdapter.dispatch_request(request, agent=agent, deps=deps)

    return router
