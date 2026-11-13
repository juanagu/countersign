from collections.abc import Awaitable, Callable

from pydantic_ai import RunContext
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.toolsets import AbstractToolset, CombinedToolset

from app.banking.token_exchange import TokenExchanger
from app.chat.deps import BotDeps

ACCOUNTS_AUDIENCE = "mcp-accounts"
PAYMENTS_AUDIENCE = "mcp-payments"


def _exchanged_auth(exchanger: TokenExchanger, audience: str) -> Callable[[RunContext[BotDeps]], Awaitable[str]]:
    """Per run: the user's token exchanged for this server's audience. The incoming token is never sent."""

    async def auth(ctx: RunContext[BotDeps]) -> str:
        return await exchanger.token_for(ctx.deps.access_token, audience)

    return auth


def banking_toolset(exchanger: TokenExchanger, *, accounts_url: str, payments_url: str) -> AbstractToolset[BotDeps]:
    servers: list[AbstractToolset[BotDeps]] = [
        # Domain errors (insufficient_funds, over_limit…) are final answers for the model to explain, not
        # mistakes to retry: 'failed' hands them over without spending the run's retry budget.
        MCPToolset(url, id=audience, auth=_exchanged_auth(exchanger, audience), tool_error_behavior="failed")
        for audience, url in ((ACCOUNTS_AUDIENCE, accounts_url), (PAYMENTS_AUDIENCE, payments_url))
    ]
    return CombinedToolset(servers)
