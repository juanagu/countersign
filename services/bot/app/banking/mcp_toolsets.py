import logging
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field, replace
from typing import Any

from pydantic_ai import RunContext
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.toolsets import AbstractToolset, ToolsetTool

from app.banking.token_exchange import TokenExchanger
from app.chat.deps import BotDeps

logger = logging.getLogger(__name__)

GATEWAY_AUDIENCE = "mcp-gateway"
# The skills whose allow-list holds a tool of any server behind the gateway (see skills/*.md).
GATEWAY_NEEDED_BY = frozenset({"accounts", "payments"})


def _exchanged_auth(exchanger: TokenExchanger, audience: str) -> Callable[[RunContext[BotDeps]], Awaitable[str]]:
    """Per run: the user's token exchanged for this audience. The incoming token is never sent."""

    async def auth(ctx: RunContext[BotDeps]) -> str:
        return await exchanger.token_for(ctx.deps.access_token, audience)

    return auth


@dataclass
class SkillGatedMCPToolset(AbstractToolset[BotDeps]):
    """The MCP gateway, connected only once a loaded skill needs it.

    Otherwise every run, even "hola", would exchange a token and open an MCP session up front, and the
    gateway or the IdP being down would fail all chats.
    """

    template: MCPToolset[BotDeps]
    needed_by: frozenset[str]
    _session: MCPToolset[BotDeps] | None = field(default=None, init=False)
    _unavailable: bool = field(default=False, init=False)

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
            if self._unavailable or not ctx.deps.loaded_skills & self.needed_by:
                return {}
            try:
                self._session = await self._connect(ctx)
            # Whatever broke (IdP refusal, network, MCP handshake), this server is down for the run, not the
            # whole chat: the model hears it from the instructions and can tell the customer.
            except Exception as error:
                self._mark_unavailable(ctx, error)
                return {}
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

    def _mark_unavailable(self, ctx: RunContext[BotDeps], error: Exception) -> None:
        self._unavailable = True
        ctx.deps.unavailable_servers.add(self.template.id or self.template.label)
        # Only the type: an error message could echo a URL or a token.
        logger.warning("mcp server unavailable", extra={"server": self.template.id, "error": type(error).__name__})

    async def _connect(self, ctx: RunContext[BotDeps]) -> MCPToolset[BotDeps]:
        session = await self.template.for_run(ctx)
        await session.__aenter__()
        return session


def banking_toolset(exchanger: TokenExchanger, *, gateway_url: str) -> AbstractToolset[BotDeps]:
    """Every banking tool, through the MCP gateway (ADR 017), which fronts mcp-accounts and mcp-payments."""
    return SkillGatedMCPToolset(
        # Domain errors (insufficient_funds, over_limit…) are final answers for the model to explain, not
        # mistakes to retry: 'failed' hands them over without spending the run's retry budget.
        MCPToolset(
            gateway_url,
            id=GATEWAY_AUDIENCE,
            auth=_exchanged_auth(exchanger, GATEWAY_AUDIENCE),
            tool_error_behavior="failed",
        ),
        needed_by=GATEWAY_NEEDED_BY,
    )
