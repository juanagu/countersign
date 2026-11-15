"""The Postgres conversation store keeps the same contract as Pydantic AI's in-memory one (skipped without Postgres)."""

import os
import uuid
from collections.abc import AsyncIterator

import psycopg
import pytest
from psycopg.conninfo import make_conninfo
from psycopg_pool import AsyncConnectionPool
from pydantic_ai import Agent, DeferredToolRequests
from pydantic_ai.conversation import Conversation
from pydantic_ai.conversation_store import ConversationConflict, ConversationStore, InMemoryConversationStore
from pydantic_ai.models.test import TestModel

from app.conversations.pg_store import PgConversationStore

DB_URL = os.environ.get("TEST_DATABASE_URL", "").replace("postgres://", "postgresql://", 1)


def _postgres_up() -> bool:
    if not DB_URL:
        return False
    try:
        with psycopg.connect(DB_URL, connect_timeout=2):
            return True
    except psycopg.Error:
        return False


POSTGRES_UP = _postgres_up()


@pytest.fixture(params=["memory", "postgres"])
async def store(request: pytest.FixtureRequest) -> AsyncIterator[ConversationStore]:
    if request.param == "memory":
        yield InMemoryConversationStore()
        return
    if not POSTGRES_UP:
        pytest.skip("test Postgres not reachable (make up)")
    name = f"chat_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(DB_URL, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        async with AsyncConnectionPool(make_conninfo(DB_URL, dbname=name), min_size=1, max_size=2, open=False) as pool:
            pg = PgConversationStore(pool)
            await pg.ensure_schema()
            await pg.ensure_schema()  # Idempotent: the bot runs it on every start.
            yield pg
    finally:
        with psycopg.connect(DB_URL, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


async def _two_turns(store: ConversationStore, conversation_id: str, scope: str) -> None:
    agent = Agent(TestModel(custom_output_text="Hola."))
    first = await agent.run("hola", conversation=Conversation(conversation_id=conversation_id))
    await store.save(first, scope=scope)
    loaded = await store.load(conversation_id, scope=scope)
    assert loaded is not None
    await store.save(await agent.run("¿y mi saldo?", conversation=loaded), scope=scope)


async def test_saves_and_loads_a_growing_conversation(store: ConversationStore) -> None:
    await _two_turns(store, "ana:t1", "ana")
    loaded = await store.load("ana:t1", scope="ana")
    assert loaded is not None
    assert len(loaded.messages) == 4
    assert [len(e) for e in [await store.load_entries("ana:t1", limit=2, scope="ana") or []]] == [2]


async def test_another_scope_reads_nothing(store: ConversationStore) -> None:
    await _two_turns(store, "ana:t2", "ana")
    assert await store.load("ana:t2", scope="juan") is None
    assert [r.conversation_id for r in await store.list_conversations(scope="juan")] == []


async def test_a_stale_revision_is_a_conflict(store: ConversationStore) -> None:
    await _two_turns(store, "ana:t3", "ana")
    record = await store.read_record("ana:t3")
    assert record is not None
    with pytest.raises(ConversationConflict):
        await store.write_record(record, expected_revision="not-the-revision")
    with pytest.raises(ConversationConflict):
        await store.write_record(record, expected_revision=None)


async def test_keeps_the_deferred_requests_a_paused_run_waits_on(store: ConversationStore) -> None:
    agent = Agent(TestModel(), output_type=[str, DeferredToolRequests])

    @agent.tool_plain(requires_approval=True)
    def execute_transfer(draft_id: str) -> str:
        return draft_id

    result = await agent.run("transferí", conversation=Conversation(conversation_id="juan:t4"))
    assert isinstance(result.output, DeferredToolRequests)
    await store.save(result, scope="juan")
    loaded = await store.load("juan:t4", scope="juan")
    assert loaded is not None and loaded.deferred_tool_requests is not None
    assert [c.tool_name for c in loaded.deferred_tool_requests.approvals] == ["execute_transfer"]
