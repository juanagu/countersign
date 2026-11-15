import json
from collections.abc import Callable
from typing import Any

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

from app.auth.token_verifier import BOT_AUDIENCE, JwksTokenVerifier, http_jwks_fetcher
from app.chat.agent import BotAgent
from app.main import create_app
from tests.conftest import ISSUER, STREAMED_CHUNKS, SigningKey, make_settings, open_guardrails

SSE = {"accept": "text/event-stream"}


def _events(body: str) -> list[dict[str, Any]]:
    return [json.loads(line[len("data: ") :]) for line in body.splitlines() if line.startswith("data: ")]


async def test_rejects_a_run_without_a_token(client: AsyncClient, run_input: Callable[..., dict[str, Any]]) -> None:
    res = await client.post("/agent", json=run_input(), headers=SSE)
    assert res.status_code == 401
    assert res.headers["www-authenticate"] == "Bearer"


async def test_rejects_a_session_token_meant_for_the_bff(
    client: AsyncClient, signing_key: SigningKey, run_input: Callable[..., dict[str, Any]]
) -> None:
    headers = {**SSE, "authorization": f"Bearer {signing_key.token(aud='bff')}"}
    res = await client.post("/agent", json=run_input(), headers=headers)
    assert res.status_code == 401


async def test_streams_text_as_ag_ui_events_a_sentence_at_a_time(
    client: AsyncClient, signing_key: SigningKey, run_input: Callable[..., dict[str, Any]]
) -> None:
    headers = {**SSE, "authorization": f"Bearer {signing_key.token()}"}
    res = await client.post("/agent", json=run_input(), headers=headers)

    assert res.status_code == 200
    assert res.headers["content-type"].startswith("text/event-stream")
    events = _events(res.text)
    types = [event["type"] for event in events]
    assert types[0] == "RUN_STARTED"
    assert types[-1] == "RUN_FINISHED"
    deltas = [event["delta"] for event in events if event["type"] == "TEXT_MESSAGE_CONTENT"]
    assert deltas == ["Hola. ", "¿En qué te ayudo?"]  # Held to sentence boundaries by the output guard.
    assert "".join(deltas) == "".join(STREAMED_CHUNKS)


async def test_user_identity_comes_from_the_token_not_the_request_body(
    client: AsyncClient,
    signing_key: SigningKey,
    run_input: Callable[..., dict[str, Any]],
    seen_user_ids: list[str],
) -> None:
    body = run_input(state={"user_id": "juan"}, forwardedProps={"user_id": "juan", "sub": "juan"})
    headers = {**SSE, "authorization": f"Bearer {signing_key.token(sub='ana')}"}
    with pytest.warns(UserWarning, match="state was ignored"):
        res = await client.post("/agent", json=body, headers=headers)

    assert res.status_code == 200
    assert seen_user_ids == ["ana"]


async def test_a_non_json_jwks_answer_is_a_503_not_a_401_or_500(
    agent: BotAgent, signing_key: SigningKey, run_input: Callable[..., dict[str, Any]]
) -> None:
    idp = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, text="<html>proxy</html>")))
    verifier = JwksTokenVerifier(http_jwks_fetcher(idp, "http://idp.test/jwks"), issuer=ISSUER, audience=BOT_AUDIENCE)
    app = create_app(make_settings(), agent=agent, token_verifier=verifier, guardrails=open_guardrails())
    async with idp, AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        headers = {**SSE, "authorization": f"Bearer {signing_key.token()}"}
        res = await client.post("/agent", json=run_input(), headers=headers)
    assert res.status_code == 503
