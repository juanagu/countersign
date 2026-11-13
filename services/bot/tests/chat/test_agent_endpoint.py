import json
from collections.abc import Callable
from typing import Any

import pytest
from httpx import AsyncClient

from tests.conftest import STREAMED_CHUNKS, SigningKey

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


async def test_streams_text_deltas_as_ag_ui_events(
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
    assert deltas == STREAMED_CHUNKS


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
