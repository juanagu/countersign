"""Retrieval quality against the ingested knowledge base (`make up && make ingest`); skipped otherwise."""

import os
from collections.abc import AsyncIterator

import psycopg
import pytest
from psycopg_pool import AsyncConnectionPool

from app.knowledge.embedder import DEFAULT_EMBEDDING_MODEL, FastEmbedEmbedder
from app.knowledge.store import PgKnowledgeStore

DB_URL = os.environ.get("TEST_DATABASE_URL", "").replace("postgres://", "postgresql://", 1)

KNOWN_QUESTIONS = [
    ("¿Cuánto me cobran por mandar una transferencia internacional de US$ 1.000?", "comisiones"),
    ("Me robaron la tarjeta, ¿cómo la bloqueo?", "bloqueo-de-tarjetas"),
    ("¿Qué requisitos necesito para abrir una cuenta?", "apertura-de-cuenta"),
    ("¿El banco me puede pedir el PIN por teléfono o por chat?", "politica-de-seguridad"),
    ("¿Cuál es el monto máximo que puedo transferir por día?", "limites-de-transferencia"),
]


def _kb_ingested() -> bool:
    if not DB_URL:
        return False
    try:
        with psycopg.connect(DB_URL, connect_timeout=2) as conn:
            return bool(conn.execute("SELECT count(*) FROM kb.chunks").fetchone())
    except psycopg.Error:
        return False


pytestmark = pytest.mark.skipif(not _kb_ingested(), reason="knowledge base not ingested (make up && make ingest)")


@pytest.fixture(scope="module")
def embedder() -> FastEmbedEmbedder:
    return FastEmbedEmbedder(os.environ.get("EMBEDDING_MODEL", DEFAULT_EMBEDDING_MODEL))


@pytest.fixture
async def store() -> AsyncIterator[PgKnowledgeStore]:
    async with AsyncConnectionPool(DB_URL, min_size=1, max_size=2, open=False) as pool:
        yield PgKnowledgeStore(pool)


@pytest.mark.parametrize(("question", "doc_id"), KNOWN_QUESTIONS)
async def test_top_3_contains_the_right_doc(
    store: PgKnowledgeStore, embedder: FastEmbedEmbedder, question: str, doc_id: str
) -> None:
    hits = await store.hybrid_search(question, await embedder.embed_query(question), ("public", "customer"), 3)
    assert doc_id in [hit.doc_id for hit in hits], [hit.doc_id for hit in hits]


async def test_public_callers_never_see_customer_docs(store: PgKnowledgeStore, embedder: FastEmbedEmbedder) -> None:
    question = "programa de beneficios y puntos Demo Más"
    hits = await store.hybrid_search(question, await embedder.embed_query(question), ("public",), 8)
    assert "beneficios-clientes" not in {hit.doc_id for hit in hits}
    customer_hits = await store.hybrid_search(question, await embedder.embed_query(question), ("public", "customer"), 3)
    assert "beneficios-clientes" in {hit.doc_id for hit in customer_hits}
