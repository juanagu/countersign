from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import Any

from pydantic_ai import RunContext
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.toolsets import AbstractToolset, CombinedToolset, ToolsetTool

from app.banking.token_exchange import TokenExchanger
from app.chat.deps import BotDeps

ACCOUNTS_AUDIENCE = "mcp-accounts"
PAYMENTS_AUDIENCE = "mcp-payments"
# The skills whose allow-list holds a tool of each server (see skills/*.md).
SKILLS_BY_AUDIENCE: dict[str, frozenset[str]] = {
    ACCOUNTS_AUDIENCE: frozenset({"accounts", "payments"}),
    PAYMENTS_AUDIENCE: frozenset({"payments"}),
}


def _exchanged_auth(exchanger: TokenExchanger, audience: str) -> Callable[[RunContext[BotDeps]], Awaitable[str]]:
    """Per run: the user's token exchanged for this server's audience. The incoming token is never sent."""

    async def auth(ctx: RunContext[BotDeps]) -> str:
        return await exchanger.token_for(ctx.deps.access_token, audience)

    return auth


@dataclass
class SkillGatedMCPToolset(AbstractToolset[BotDeps]):
    """One MCP server, connected only once a loaded skill needs it.

    Otherwise every run, even "hola", would exchange tokens and open every MCP session up front, and one
    server or the IdP being down would fail all chats.
    """

    template: MCPToolset[BotDeps]
    needed_by: frozenset[str]
    _session: MCPToolset[BotDeps] | None = field(default=None, init=False)

    @property
    def id(self) -> str | None:
        return self.template.id

    @property
    def label(self) -> str:
        return f"{type(self).__name__}({self.template.label})"

    async def for_run(self, ctx: RunContext[BotDeps]) -> "SkillGatedMCPToolset":
        return replace(self)  # A fresh copy, so no session is shared across runs.

    async def get_tools(self, ctx: RunContext[BotDeps]) -> dict[str, ToolsetTool[BotDeps]]:
        if self._session is None:
            if not ctx.deps.loaded_skills & self.needed_by:
                return {}
            self._session = await self._connect(ctx)
        return await self._session.get_tools(ctx)

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[BotDeps], tool: ToolsetTool[BotDeps]
    ) -> Any:
        if self._session is None:
            raise RuntimeError(f"{self.label} called before any skill needed it")
        return await self._session.call_tool(name, tool_args, ctx, tool)

    async def __aexit__(self, *args: Any) -> bool | None:
        session, self._session = self._session, None
        return await session.__aexit__(*args) if session else None

    async def _connect(self, ctx: RunContext[BotDeps]) -> MCPToolset[BotDeps]:
        session = await self.template.for_run(ctx)
        await session.__aenter__()
        return session


def banking_toolset(exchanger: TokenExchanger, *, accounts_url: str, payments_url: str) -> AbstractToolset[BotDeps]:
    servers: list[AbstractToolset[BotDeps]] = [
        SkillGatedMCPToolset(
            # Domain errors (insufficient_funds, over_limit…) are final answers for the model to explain, not
            # mistakes to retry: 'failed' hands them over without spending the run's retry budget.
            MCPToolset(url, id=audience, auth=_exchanged_auth(exchanger, audience), tool_error_behavior="failed"),
            needed_by=SKILLS_BY_AUDIENCE[audience],
        )
        for audience, url in ((ACCOUNTS_AUDIENCE, accounts_url), (PAYMENTS_AUDIENCE, payments_url))
    ]
    return CombinedToolset(servers)
