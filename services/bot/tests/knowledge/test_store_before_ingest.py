"""Search against a database `make ingest` never ran on: a fresh, empty one on the test Postgres; skipped without it."""

import logging
import os
import uuid
from collections.abc import AsyncIterator

import psycopg
import pytest
from psycopg.conninfo import make_conninfo
from psycopg_pool import AsyncConnectionPool

from app.knowledge.store import PgKnowledgeStore

DB_URL = os.environ.get("TEST_DATABASE_URL", "").replace("postgres://", "postgresql://", 1)


def _postgres_up() -> bool:
    if not DB_URL:
        return False
    try:
        with psycopg.connect(DB_URL, connect_timeout=2):
            return True
    except psycopg.Error:
        return False


pytestmark = pytest.mark.skipif(not _postgres_up(), reason="test Postgres not reachable (make up)")


@pytest.fixture
async def empty_store() -> AsyncIterator[PgKnowledgeStore]:
    name = f"kb_empty_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(DB_URL, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    try:
        async with AsyncConnectionPool(make_conninfo(DB_URL, dbname=name), min_size=1, max_size=1, open=False) as pool:
            yield PgKnowledgeStore(pool)
    finally:
        with psycopg.connect(DB_URL, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


async def test_returns_no_hits_and_warns_before_ingest(
    empty_store: PgKnowledgeStore, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger="app.knowledge.store"):
        hits = await empty_store.hybrid_search("¿Cuánto cuesta una transferencia?", [0.1, 0.2], ["public"], 4)

    assert hits == []
    assert "not ingested" in caplog.text
