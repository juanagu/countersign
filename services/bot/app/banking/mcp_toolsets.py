import json
import logging
from collections.abc import Callable, Mapping
from contextlib import AsyncExitStack
from dataclasses import dataclass, field, replace
from typing import Any

from pydantic_ai import RunContext, ToolFailed
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.toolsets import AbstractToolset, ToolsetTool

from app.banking.token_exchange import TokenExchangeError, TokenExchanger
from app.chat.deps import BotDeps
from app.policy.risk_tier import RISK_TIER_META_KEY, RiskTier
from app.policy.tool_scopes import read_scope

logger = logging.getLogger(__name__)

GATEWAY_AUDIENCE = "mcp-gateway"

SessionFactory = Callable[[str], MCPToolset[BotDeps]]
"""Builds an unopened MCP session on the gateway that authenticates with the given bearer token."""


def _error_fields(error: Exception) -> dict[str, str]:
    """What a failure may log: its type and, for a refused exchange, the RFC 6749 code. Never a message or body."""
    code = error.code if isinstance(error, TokenExchangeError) else None
    return {"error": type(error).__name__, **({"oauth_error": code} if code else {})}


def _meta(tool: ToolsetTool[BotDeps]) -> Mapping[str, object]:
    meta = (tool.tool_def.metadata or {}).get("meta")
    return meta if isinstance(meta, Mapping) else {}


@dataclass
class SkillGatedMCPToolset(AbstractToolset[BotDeps]):
    """The MCP gateway, connected with a token scoped to the loaded skills.

    No skill that needs the gateway, no exchange and no session: otherwise every run, even "hola", would open one,
    and the gateway or the IdP being down would fail all chats. `transfers:execute` is never in a session's token;
    an approved T3 call gets its own token and session for that one call.
    """

    open_session: SessionFactory
    exchanger: TokenExchanger
    scopes_by_skill: Mapping[str, frozenset[str]]
    audience: str = GATEWAY_AUDIENCE
    # Shared by every run's copy, so a tool hidden for lack of a scope is logged once per process.
    hidden_logged: set[str] = field(default_factory=set)
    _session: MCPToolset[BotDeps] | None = field(default=None, init=False)
    _session_scopes: frozenset[str] = field(default=frozenset(), init=False)
    _unavailable: bool = field(default=False, init=False)

    @property
    def id(self) -> str | None:
        return self.audience

    @property
    def label(self) -> str:
        return f"{type(self).__name__}({self.audience})"

    async def for_run(self, ctx: RunContext[BotDeps]) -> "SkillGatedMCPToolset":
        return replace(self)  # A fresh copy, so no session is shared across runs.

    async def get_tools(self, ctx: RunContext[BotDeps]) -> dict[str, ToolsetTool[BotDeps]]:
        if self._unavailable:
            return {}
        try:
            session = await self._session_for(ctx)
        # Whatever broke (IdP refusal, network, MCP handshake), this server is down for the run, not the
        # whole chat: the model hears it from the instructions and can tell the customer.
        except Exception as error:
            self._mark_unavailable(ctx, error)
            return {}
        if session is None:
            return {}
        tools = await session.get_tools(ctx)
        return {name: tool for name, tool in tools.items() if self._has_scope(name, tool)}

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[BotDeps], tool: ToolsetTool[BotDeps]
    ) -> Any:
        scope = read_scope(_meta(tool))
        if scope and scope not in self._session_scopes and ctx.tool_call_approved and self._is_t3(tool):
            return await self._call_approved(scope, name, tool_args, ctx, tool)
        # Anything else goes out on the session token, even a call the policy should have stopped: the gateway
        # refuses a scope the token lacks, and that refusal is the lock, not a second guess here.
        if self._session is None:
            raise RuntimeError(f"{self.label} called before any skill needed it")
        return await self._session.call_tool(name, tool_args, ctx, tool)

    async def __aexit__(self, *args: Any) -> bool | None:
        return await self._close_session(*args)

    async def _session_for(self, ctx: RunContext[BotDeps]) -> MCPToolset[BotDeps] | None:
        """The run's session, re-opened with a new token when the loaded skills ask for more scopes."""
        wanted = frozenset().union(*(self.scopes_by_skill.get(skill, frozenset()) for skill in ctx.deps.loaded_skills))
        if not wanted:
            return None
        if self._session is not None and wanted <= self._session_scopes:
            return self._session
        try:
            token = await self.exchanger.token_for(ctx.deps.access_token, self.audience, wanted)
            session = self.open_session(token)
            await session.__aenter__()
        except Exception as error:
            # Growing failed, but the session that works stays: the customer keeps the tools already loaded.
            if self._session is None:
                raise
            logger.warning("mcp session growth failed", extra={"server": self.audience, **_error_fields(error)})
            return self._session
        await self._close_session(None, None, None)  # Only after the new one is up.
        self._session, self._session_scopes = session, wanted
        return session

    async def _call_approved(
        self, scope: str, name: str, tool_args: dict[str, Any], ctx: RunContext[BotDeps], tool: ToolsetTool[BotDeps]
    ) -> Any:
        """One call on a token that holds only this tool's scope, through a session closed right after."""
        async with AsyncExitStack() as stack:
            try:
                token = await self.exchanger.token_for(ctx.deps.access_token, self.audience, frozenset({scope}))
                session = await stack.enter_async_context(self.open_session(token))
            except Exception as error:
                # Nothing was sent, so the step-up token is unspent and the customer can ask again.
                logger.warning("approved call setup failed", extra={"tool": name, **_error_fields(error)})
                raise ToolFailed(
                    json.dumps({"error": "service_unavailable", "service": self.audience}, separators=(",", ":"))
                ) from error
            return await session.call_tool(name, tool_args, ctx, tool)

    async def _close_session(self, *args: Any) -> bool | None:
        session, self._session, self._session_scopes = self._session, None, frozenset()
        return await session.__aexit__(*args) if session else None

    def _has_scope(self, name: str, tool: ToolsetTool[BotDeps]) -> bool:
        if read_scope(_meta(tool)):
            return True
        if name not in self.hidden_logged:
            self.hidden_logged.add(name)
            logger.warning("mcp tool hidden: no valid scope", extra={"server": self.audience, "tool": name})
        return False

    @staticmethod
    def _is_t3(tool: ToolsetTool[BotDeps]) -> bool:
        return RiskTier.parse(_meta(tool).get(RISK_TIER_META_KEY)) is RiskTier.T3

    def _mark_unavailable(self, ctx: RunContext[BotDeps], error: Exception) -> None:
        self._unavailable = True
        ctx.deps.unavailable_servers.add(self.audience)
        # Only the type: an error message could echo a URL or a token.
        logger.warning("mcp server unavailable", extra={"server": self.audience, **_error_fields(error)})


def banking_toolset(
    exchanger: TokenExchanger, *, gateway_url: str, scopes_by_skill: Mapping[str, frozenset[str]]
) -> AbstractToolset[BotDeps]:
    """Every banking tool, through the MCP gateway, which fronts mcp-accounts and mcp-payments.

    `scopes_by_skill` holds the gateway scopes each skill requests (its frontmatter `scopes`).
    """

    def gateway_session(token: str) -> MCPToolset[BotDeps]:
        # Domain errors (insufficient_funds, over_limit…) are final answers for the model to explain, not
        # mistakes to retry: 'failed' hands them over without spending the run's retry budget.
        return MCPToolset(gateway_url, id=GATEWAY_AUDIENCE, auth=token, tool_error_behavior="failed")

    return SkillGatedMCPToolset(gateway_session, exchanger, scopes_by_skill)
