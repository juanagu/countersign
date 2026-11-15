"""A failed-over run through the real `/agent` endpoint (ADR 018): one answer, from the backup, on the span."""

import json
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic_ai.exceptions import ModelOverloadedError

from app.auth.token_verifier import JwksTokenVerifier
from app.chat.agent import build_agent
from app.config import SKILLS_DIR
from app.guardrails.stream_timing import StreamTimer
from app.main import create_app
from app.skills.registry import SkillRegistry
from tests.conftest import SigningKey, make_settings, open_guardrails
from tests.core.llm.fakes import Fake, chain

SSE = {"accept": "text/event-stream"}


def _events(body: str) -> list[dict[str, Any]]:
    return [json.loads(line[len("data: ") :]) for line in body.splitlines() if line.startswith("data: ")]


async def test_a_failed_over_run_streams_exactly_one_answer_from_the_backup(
    verifier: JwksTokenVerifier, signing_key: SigningKey, monkeypatch: pytest.MonkeyPatch
) -> None:
    span_attributes: list[dict[str, Any]] = []
    finish = StreamTimer.finish

    def recording_finish(self: StreamTimer, attributes: Any = None) -> None:
        span_attributes.append(dict(attributes or {}))
        finish(self, attributes)

    monkeypatch.setattr(StreamTimer, "finish", recording_finish)
    primary = Fake("primary", error=lambda name: ModelOverloadedError(name, "overloaded"))
    backup = Fake("backup", text="Hola, soy el backup. ¿En qué te ayudo?")
    agent = build_agent(chain(primary, backup), skills=SkillRegistry.from_dir(SKILLS_DIR))
    app = create_app(make_settings(), agent=agent, token_verifier=verifier, guardrails=open_guardrails())
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        body = {"threadId": "t1", "runId": "r1", "messages": [{"id": "u1", "role": "user", "content": "hola"}]}
        body |= {"tools": [], "context": [], "state": {}, "forwardedProps": {}}
        res = await http.post("/agent", json=body, headers={**SSE, "authorization": f"Bearer {signing_key.token()}"})

    events = _events(res.text)
    types = [event["type"] for event in events]
    assert types[0] == "RUN_STARTED" and types[-1] == "RUN_FINISHED"
    assert "RUN_ERROR" not in types
    assert types.count("TEXT_MESSAGE_START") == 1
    text = "".join(event["delta"] for event in events if event["type"] == "TEXT_MESSAGE_CONTENT")
    assert text.strip() == backup.text
    assert primary.calls == ["primary"] and backup.calls == ["backup"]
    assert span_attributes == [{"bot.models_served": ["orchestrator:backup"], "bot.failovers": 1}]
