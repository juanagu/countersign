import json
import time
import uuid
from collections.abc import AsyncIterator, Callable
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from httpx import ASGITransport, AsyncClient
from pydantic_ai import Agent
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, DeltaToolCalls, FunctionModel

from app.auth.token_verifier import BOT_AUDIENCE, JwksTokenVerifier
from app.chat.agent import build_agent
from app.chat.deps import BotDeps
from app.config import SKILLS_DIR, Settings
from app.main import create_app
from app.skills.registry import SkillRegistry

ISSUER = "http://idp.test"
KID = "test-key"
STREAMED_CHUNKS = ["Hola", ", ¿en qué ", "te ayudo?"]
TEST_MODEL = "test"
TEST_CLIENT_SECRET = "test-bot-client-secret"


class SigningKey:
    def __init__(self, kid: str = KID) -> None:
        self.kid = kid
        self.private = ec.generate_private_key(ec.SECP256R1())

    def jwk(self) -> dict[str, Any]:
        jwk: dict[str, Any] = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(self.private.public_key()))
        return {**jwk, "kid": self.kid, "alg": "ES256", "use": "sig"}

    def token(self, **overrides: Any) -> str:
        now = int(time.time())
        claims: dict[str, Any] = {
            "iss": ISSUER,
            "aud": BOT_AUDIENCE,
            "sub": "ana",
            "iat": now,
            "exp": now + 300,
            "jti": str(uuid.uuid4()),
            "scope": "chat",
        }
        claims.update(overrides)
        claims = {k: v for k, v in claims.items() if v is not None}
        return jwt.encode(claims, self.private, algorithm="ES256", headers={"kid": self.kid})


@pytest.fixture
def signing_key() -> SigningKey:
    return SigningKey()


@pytest.fixture
def verifier(signing_key: SigningKey) -> JwksTokenVerifier:
    async def fetch() -> dict[str, Any]:
        return {"keys": [signing_key.jwk()]}

    return JwksTokenVerifier(fetch, issuer=ISSUER, audience=BOT_AUDIENCE)


async def _stream_chunks(_: list[ModelMessage], __: AgentInfo) -> AsyncIterator[str | DeltaToolCalls]:
    for chunk in STREAMED_CHUNKS:
        yield chunk


@pytest.fixture
def seen_user_ids() -> list[str]:
    return []


@pytest.fixture
def agent(seen_user_ids: list[str]) -> Agent[BotDeps, str]:
    test_agent = build_agent(FunctionModel(stream_function=_stream_chunks), skills=SkillRegistry.from_dir(SKILLS_DIR))

    @test_agent.instructions
    def record_user(ctx: Any) -> str:
        seen_user_ids.append(ctx.deps.user_id)
        return ""

    return test_agent


@pytest.fixture
async def client(agent: Agent[BotDeps, str], verifier: JwksTokenVerifier) -> AsyncIterator[AsyncClient]:
    app = create_app(
        Settings(bot_model=TEST_MODEL, bot_client_secret=TEST_CLIENT_SECRET), agent=agent, token_verifier=verifier
    )
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield http


@pytest.fixture
def run_input() -> Callable[..., dict[str, Any]]:
    def build(**overrides: Any) -> dict[str, Any]:
        body: dict[str, Any] = {
            "threadId": "thread-1",
            "runId": str(uuid.uuid4()),
            "messages": [{"id": "u1", "role": "user", "content": "hola"}],
            "tools": [],
            "context": [],
            "state": {},
            "forwardedProps": {},
        }
        body.update(overrides)
        return body

    return build
