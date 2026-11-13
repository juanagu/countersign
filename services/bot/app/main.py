from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from pydantic_ai import Agent

from app.auth.token_verifier import BOT_AUDIENCE, JwksTokenVerifier, TokenVerifier, http_jwks_fetcher
from app.chat.agent import BotDeps, build_agent
from app.chat.routes import chat_router
from app.config import Settings
from app.core.logging import configure_logging
from app.core.telemetry import setup_telemetry

SERVICE_NAME = "bot"


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

    app.include_router(chat_router(agent or build_agent(settings.bot_model)))
    setup_telemetry(app, settings)
    return app
