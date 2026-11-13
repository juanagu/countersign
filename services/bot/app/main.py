from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI
from pydantic_ai import Agent

from app.auth.token_verifier import BOT_AUDIENCE, JwksTokenVerifier, TokenVerifier, http_jwks_fetcher
from app.banking.mcp_toolsets import banking_toolset
from app.banking.token_exchange import TokenExchanger
from app.chat.agent import build_agent
from app.chat.deps import BotDeps
from app.chat.routes import chat_router
from app.config import Settings
from app.core.clock import BankClock
from app.core.logging import configure_logging
from app.core.telemetry import setup_telemetry
from app.skills.registry import SkillRegistry

SERVICE_NAME = "bot"


def _default_agent(settings: Settings, http: httpx.AsyncClient) -> Agent[BotDeps, str]:
    exchanger = TokenExchanger(
        http,
        token_url=settings.idp_token_url,
        client_id=settings.bot_client_id,
        client_secret=settings.bot_client_secret,
    )
    tools = banking_toolset(exchanger, accounts_url=settings.mcp_accounts_url, payments_url=settings.mcp_payments_url)
    return build_agent(
        settings.bot_model,
        skills=SkillRegistry.from_dir(settings.skills_dir),
        domain_tools=[tools],
        clock=BankClock(ZoneInfo(settings.bank_timezone)),
    )


def create_app(
    settings: Settings | None = None,
    agent: Agent[BotDeps, str] | None = None,
    token_verifier: TokenVerifier | None = None,
) -> FastAPI:
    """Composition root. Served with `uvicorn app.main:create_app --factory`."""
    settings = settings or Settings()
    configure_logging(settings.log_level)
    http = httpx.AsyncClient()

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        yield
        await http.aclose()

    app = FastAPI(title="Banking assistant bot", lifespan=lifespan)
    app.state.token_verifier = token_verifier or JwksTokenVerifier(
        http_jwks_fetcher(http, settings.idp_jwks_url), issuer=settings.idp_issuer, audience=BOT_AUDIENCE
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": SERVICE_NAME}

    app.include_router(chat_router(agent or _default_agent(settings, http)))
    setup_telemetry(app, settings)
    return app
