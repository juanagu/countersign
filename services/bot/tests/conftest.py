import asyncio
import json
import sys
import time
import uuid
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from pathlib import Path
from typing import Any

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from httpx import ASGITransport, AsyncClient
from pydantic_ai.messages import ModelMessage
from pydantic_ai.models.function import AgentInfo, DeltaToolCalls, FunctionModel

from app.auth.token_verifier import BOT_AUDIENCE, JwksTokenVerifier
from app.chat.agent import BotAgent, build_agent
from app.config import SKILLS_DIR, Settings
from app.guardrails.input_classifier import InputClassifier
from app.guardrails.pipeline import Guardrails
from app.guardrails.run_guard import RunGuard, WriteIntentCheck
from app.guardrails.verdict import ALLOW, Verdict
from app.main import create_app
from app.skills.registry import SkillRegistry

ISSUER = "http://idp.test"
KID = "test-key"
STREAMED_CHUNKS = ["Hola. ", "¿En qué ", "te ayudo?"]
TEST_MODEL = "test"
TEST_CLIENT_SECRET = "test-bot-client-secret"
# The shipped accounts and knowledge skills, plus a root payments skill that prepares and executes in one T3 skill: the
# approval and template mechanism tests run on it, apart from the subagent's.
TEST_SKILLS_DIR = Path(__file__).resolve().parent / "fixtures" / "skills"
NO_SUBAGENTS_DIR = TEST_SKILLS_DIR.parent / "no-subagents"  # Missing on purpose: its payments skill would clash.

if sys.platform == "win32":
    # psycopg's async mode refuses Windows' default Proactor loop. Defined only here: the hook may not return None.
    def pytest_asyncio_loop_factories(config: pytest.Config, item: pytest.Item) -> dict[str, Any]:
        return {"selector": asyncio.SelectorEventLoop}


async def allow_input(text: str, user_id: str) -> Verdict:
    return ALLOW


async def allow_writes(customer_messages: Sequence[str], tool: str, args: Mapping[str, Any]) -> Verdict:
    return ALLOW


def open_guardrails(
    classifier: InputClassifier = allow_input, write_intent: WriteIntentCheck = allow_writes
) -> Guardrails:
    """Guardrails whose checks allow everything, for tests about something else."""
    return Guardrails(classifier=classifier, write_intent=write_intent)


def open_guard(customer_messages: Sequence[str] = ()) -> RunGuard:
    """A run guard whose input verdict is already `allow`."""
    guard = RunGuard(customer_messages=list(customer_messages), write_intent=allow_writes)
    guard.decide(ALLOW)
    return guard


def make_settings() -> Settings:
    return Settings(
        bot_model=TEST_MODEL,
        guard_model=TEST_MODEL,
        bot_client_secret=TEST_CLIENT_SECRET,
        skills_dir=TEST_SKILLS_DIR,
        subagents_dir=NO_SUBAGENTS_DIR,
    )


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
def agent(seen_user_ids: list[str]) -> BotAgent:
    test_agent = build_agent(FunctionModel(stream_function=_stream_chunks), skills=SkillRegistry.from_dir(SKILLS_DIR))

    @test_agent.instructions
    def record_user(ctx: Any) -> str:
        seen_user_ids.append(ctx.deps.user_id)
        return ""

    return test_agent


@pytest.fixture
async def client(agent: BotAgent, verifier: JwksTokenVerifier) -> AsyncIterator[AsyncClient]:
    app = create_app(make_settings(), agent=agent, token_verifier=verifier, guardrails=open_guardrails())
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
