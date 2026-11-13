"""`make seed` drops the role's own schema with CASCADE; the knowledge base must survive it."""

import os
import uuid
from collections.abc import AsyncIterator

import psycopg
import pytest
from psycopg.conninfo import make_conninfo
from psycopg_pool import AsyncConnectionPool

from app.knowledge.chunker import Chunk
from app.knowledge.store import PgKnowledgeStore

DB_URL = os.environ.get("TEST_DATABASE_URL", "").replace("postgres://", "postgresql://", 1)
CHUNK = Chunk("comisiones", "Comisiones", "public", "Transferencias", "transferencias", "Gratis a otros bancos.")


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
async def database() -> AsyncIterator[str]:
    """A throwaway database with a schema named after the role, as the seeded bank database has."""
    name = f"kb_seed_{uuid.uuid4().hex[:12]}"
    with psycopg.connect(DB_URL, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
    conninfo = make_conninfo(DB_URL, dbname=name)
    try:
        with psycopg.connect(conninfo, autocommit=True) as conn:
            conn.execute('CREATE SCHEMA "bank"')
        yield conninfo
    finally:
        with psycopg.connect(DB_URL, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')


async def test_ingested_vectors_survive_dropping_the_bank_schema(database: str) -> None:
    async with AsyncConnectionPool(database, min_size=1, max_size=1, open=False) as pool:
        store = PgKnowledgeStore(pool)
        await store.replace_all([CHUNK], [[0.1, 0.2, 0.3]], dim=3)
        with psycopg.connect(database, autocommit=True) as conn:
            conn.execute('DROP SCHEMA "bank" CASCADE')  # what `make seed` does first
        hits = await store.hybrid_search("transferencias", [0.1, 0.2, 0.3], ["public"], k=3)
    assert [hit.doc_id for hit in hits] == ["comisiones"]
