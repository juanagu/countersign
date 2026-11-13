import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from zoneinfo import ZoneInfo

import httpx
from fastapi import FastAPI
from psycopg_pool import AsyncConnectionPool

from app.auth.token_verifier import BOT_AUDIENCE, JwksTokenVerifier, TokenVerifier, http_jwks_fetcher
from app.banking.mcp_toolsets import banking_toolset
from app.banking.token_exchange import TokenExchanger
from app.chat.agent import BotAgent, build_agent
from app.chat.routes import chat_router
from app.config import Settings
from app.core.clock import BankClock
from app.core.logging import configure_logging
from app.core.telemetry import setup_telemetry
from app.guardrails.log_redaction import RedactingFilter
from app.guardrails.pipeline import Guardrails
from app.guardrails.span_redaction import RedactingSpanExporter
from app.knowledge.embedder import FastEmbedEmbedder, LazyEmbedder
from app.knowledge.search_tool import knowledge_toolset
from app.knowledge.store import PgKnowledgeStore
from app.skills.registry import SkillRegistry

SERVICE_NAME = "bot"


def _default_agent(
    settings: Settings,
    http: httpx.AsyncClient,
    pool: AsyncConnectionPool,
    embedder: LazyEmbedder,
    skills: SkillRegistry,
    clock: BankClock,
) -> BotAgent:
    exchanger = TokenExchanger(
        http,
        token_url=settings.idp_token_url,
        client_id=settings.bot_client_id,
        client_secret=settings.bot_client_secret,
    )
    tools = banking_toolset(exchanger, accounts_url=settings.mcp_accounts_url, payments_url=settings.mcp_payments_url)
    knowledge = knowledge_toolset(embedder, PgKnowledgeStore(pool))
    return build_agent(
        settings.bot_model,
        skills=skills,
        domain_tools=[tools, knowledge],
        clock=clock,
    )


def create_app(
    settings: Settings | None = None,
    agent: BotAgent | None = None,
    token_verifier: TokenVerifier | None = None,
    guardrails: Guardrails | None = None,
) -> FastAPI:
    """Composition root. Served with `uvicorn app.main:create_app --factory`."""
    settings = settings or Settings()
    configure_logging(settings.log_level, filters=[RedactingFilter()])
    http = httpx.AsyncClient()
    pool = AsyncConnectionPool(settings.database_url, min_size=1, max_size=5, open=False)
    embedder = LazyEmbedder(FastEmbedEmbedder, settings.embedding_model, settings.embedding_cache_dir)

    @asynccontextmanager
    async def lifespan(_: FastAPI) -> AsyncIterator[None]:
        if agent is None:
            await pool.open(wait=False)
            # Load the embedding model in the background so the first question doesn't wait for it.
            warm_up = asyncio.create_task(embedder.warm_up())
        yield
        if agent is None:
            warm_up.cancel()
            await pool.close()
        await http.aclose()

    app = FastAPI(title="Banking assistant bot", lifespan=lifespan)
    app.state.token_verifier = token_verifier or JwksTokenVerifier(
        http_jwks_fetcher(http, settings.idp_jwks_url), issuer=settings.idp_issuer, audience=BOT_AUDIENCE
    )

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok", "service": SERVICE_NAME}

    skills = SkillRegistry.from_dir(settings.skills_dir)
    clock = BankClock(ZoneInfo(settings.bank_timezone))  # One calendar for the prompt, the policy and grounding.
    guardrails = guardrails or Guardrails.on_model(settings.guard_model, clock=clock)
    run_agent = agent or _default_agent(settings, http, pool, embedder, skills, clock)
    app.include_router(chat_router(run_agent, skills, guardrails))
    setup_telemetry(app, settings, wrap_exporter=RedactingSpanExporter)
    return app
