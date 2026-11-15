"""The live client's PIN and refusal handling: a wrong PIN is an answer the journey can read, not an exception."""

import json
import os
import uuid
from collections.abc import AsyncIterator

import httpx
import psycopg
import pytest

from evals.agui_client import BffSession
from evals.bank_db import database_url, expire_draft

CARD = {"data": {"draftId": "drf_x", "amount": "50000.00", "currency": "ARS", "beneficiaryId": "ben-juan-ana"}}
INTERRUPT = {"id": "int-x", "toolCallId": "x"}


def _session(handler: httpx.MockTransport) -> BffSession:
    return BffSession(httpx.AsyncClient(transport=handler, base_url="http://bff"))


async def test_a_wrong_pin_returns_its_status_and_a_right_one_a_token() -> None:
    answers = iter(
        [httpx.Response(401, json={"error": "invalid_pin"}), httpx.Response(200, json={"step_up_token": "t"})]
    )
    session = _session(httpx.MockTransport(lambda _: next(answers)))

    wrong = await session.try_step_up(CARD, "000000")
    right = await session.try_step_up(CARD, "123456")

    assert (wrong.status, wrong.token, wrong.body) == (401, None, {"error": "invalid_pin"})
    assert (right.status, right.token) == (200, "t")
    assert session.step_up_statuses == [401, 200]


async def test_step_up_raises_when_the_pin_is_refused() -> None:
    session = _session(httpx.MockTransport(lambda _: httpx.Response(401, json={"error": "invalid_pin"})))

    with pytest.raises(RuntimeError, match="401"):
        await session.step_up(CARD, "000000")


async def test_a_refused_resume_marks_the_interrupted_call_cancelled() -> None:
    sse = "data: " + json.dumps({"type": "RUN_FINISHED", "outcome": {"type": "success"}}) + "\n"
    session = _session(httpx.MockTransport(lambda _: httpx.Response(200, text=sse)))

    refused = await session.resume(INTERRUPT, {"approved": False, "reason": "no"})
    approved = await session.resume(INTERRUPT, {"approved": True})

    assert refused.cancelled == {"x"}
    assert approved.cancelled == frozenset()


@pytest.fixture
async def database() -> AsyncIterator[psycopg.AsyncConnection]:
    if not os.environ.get("TEST_DATABASE_URL"):
        pytest.skip("needs the seeded compose Postgres (TEST_DATABASE_URL)")
    try:
        conn = await psycopg.AsyncConnection.connect(database_url(), autocommit=True)
    except psycopg.OperationalError:
        pytest.skip("Postgres is not reachable")
    async with conn:
        yield conn


@pytest.fixture
async def pending_draft(database: psycopg.AsyncConnection) -> AsyncIterator[str]:
    draft_id = f"drf_{uuid.uuid4()}"
    insert = """
        INSERT INTO bank.transfer_drafts (id, customer_id, source_account_id, beneficiary_id, amount, currency, fee,
                                          status, expires_at)
        SELECT %(id)s, customer_id, id, 'ben-juan-ana', 1, 'ARS', 0, 'pending', now() + interval '10 minutes'
          FROM bank.accounts WHERE id = 'acc-juan-ars'
    """
    await database.execute(insert, {"id": draft_id})
    yield draft_id
    await database.execute("DELETE FROM bank.transfer_drafts WHERE id = %s", (draft_id,))


async def test_expiring_a_draft_moves_its_expiry_into_the_past(
    database: psycopg.AsyncConnection, pending_draft: str
) -> None:
    await expire_draft(pending_draft)

    cursor = await database.execute(
        "SELECT expires_at < now() FROM bank.transfer_drafts WHERE id = %s", (pending_draft,)
    )
    assert await cursor.fetchone() == (True,)


@pytest.mark.usefixtures("database")
async def test_expiring_an_unknown_draft_fails_loudly() -> None:
    with pytest.raises(LookupError):
        await expire_draft("drf_does-not-exist")
