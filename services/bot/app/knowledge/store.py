import logging
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from psycopg import AsyncConnection
from psycopg.errors import UndefinedTable
from psycopg_pool import AsyncConnectionPool

from app.knowledge.chunker import Audience, Chunk

logger = logging.getLogger(__name__)

# Reciprocal rank fusion constant (Cormack et al.); 60 is the usual default.
RRF_K = 60
CANDIDATES_PER_RETRIEVER = 20


@dataclass(frozen=True)
class SearchHit:
    doc_id: str
    title: str
    heading: str
    anchor: str
    content: str
    score: float


class KnowledgeStore(Protocol):
    async def replace_all(self, chunks: Sequence[Chunk], embeddings: Sequence[list[float]], dim: int) -> None: ...

    async def hybrid_search(
        self, query: str, query_embedding: list[float], audiences: Sequence[Audience], k: int
    ) -> list[SearchHit]: ...


def rrf_merge(rankings: Sequence[Sequence[int]], k: int, rrf_k: int = RRF_K) -> list[tuple[int, float]]:
    """Fuses ranked id lists: each list adds 1 / (rrf_k + rank) to an id's score."""
    scores: dict[int, float] = {}
    for ranking in rankings:
        for rank, item in enumerate(ranking, start=1):
            scores[item] = scores.get(item, 0.0) + 1.0 / (rrf_k + rank)
    return sorted(scores.items(), key=lambda pair: pair[1], reverse=True)[:k]


def _vector_literal(vector: Sequence[float]) -> str:
    return "[" + ",".join(f"{x:.7f}" for x in vector) + "]"


class PgKnowledgeStore:
    """Chunks in pgvector with a Spanish full-text column; hybrid search fused with RRF in Python."""

    def __init__(self, pool: AsyncConnectionPool):
        self._pool = pool

    async def replace_all(self, chunks: Sequence[Chunk], embeddings: Sequence[list[float]], dim: int) -> None:
        async with self._pool.connection() as conn, conn.transaction():
            # Pinned to public: the default search path puts the role's own schema ("bank") first, and `make seed`
            # drops that schema with CASCADE, which would take the extension and every vector column with it.
            await conn.execute("CREATE EXTENSION IF NOT EXISTS vector SCHEMA public")
            await conn.execute("DROP SCHEMA IF EXISTS kb CASCADE")
            await conn.execute("CREATE SCHEMA kb")
            await conn.execute(
                f"""CREATE TABLE kb.chunks (
                      id serial PRIMARY KEY,
                      doc_id text NOT NULL,
                      title text NOT NULL,
                      audience text NOT NULL,
                      heading text NOT NULL,
                      anchor text NOT NULL,
                      content text NOT NULL,
                      embedding vector({int(dim)}) NOT NULL,
                      tsv tsvector GENERATED ALWAYS AS (
                        to_tsvector('spanish', title || ' ' || heading || ' ' || content)) STORED)"""
            )
            await conn.execute("CREATE INDEX ON kb.chunks USING hnsw (embedding vector_cosine_ops)")
            await conn.execute("CREATE INDEX ON kb.chunks USING gin (tsv)")
            async with conn.cursor() as cur:
                await cur.executemany(
                    """INSERT INTO kb.chunks (doc_id, title, audience, heading, anchor, content, embedding)
                       VALUES (%s, %s, %s, %s, %s, %s, %s::vector)""",
                    [
                        (c.doc_id, c.title, c.audience, c.heading, c.anchor, c.content, _vector_literal(e))
                        for c, e in zip(chunks, embeddings, strict=True)
                    ],
                )

    async def hybrid_search(
        self, query: str, query_embedding: list[float], audiences: Sequence[Audience], k: int
    ) -> list[SearchHit]:
        try:
            async with self._pool.connection() as conn:
                return await self._search(conn, query, query_embedding, list(audiences), k)
        except UndefinedTable:
            # Before `make ingest` there is no kb.chunks: no hits lets the skill say "No tengo esa información"
            # instead of failing the whole chat run.
            logger.warning("knowledge base not ingested; search returns no hits")
            return []

    async def _search(
        self, conn: AsyncConnection[Any], query: str, query_embedding: list[float], allowed: list[str], k: int
    ) -> list[SearchHit]:
        vector_rows = await (
            await conn.execute(
                """SELECT id FROM kb.chunks WHERE audience = ANY(%s)
                   ORDER BY embedding <=> %s::vector LIMIT %s""",
                (allowed, _vector_literal(query_embedding), CANDIDATES_PER_RETRIEVER),
            )
        ).fetchall()
        text_rows = await (
            await conn.execute(
                # Any query term may match (OR): questions are full sentences, and requiring every
                # lexeme (websearch/plainto semantics) leaves the keyword retriever almost always empty.
                """SELECT id FROM kb.chunks,
                          (SELECT replace(plainto_tsquery('spanish', %s)::text, '&', '|')::tsquery AS q) query
                   WHERE audience = ANY(%s) AND tsv @@ query.q
                   ORDER BY ts_rank_cd(tsv, query.q) DESC LIMIT %s""",
                (query, allowed, CANDIDATES_PER_RETRIEVER),
            )
        ).fetchall()
        fused = rrf_merge([[r[0] for r in vector_rows], [r[0] for r in text_rows]], k)
        if not fused:
            return []
        rows = await (
            await conn.execute(
                "SELECT id, doc_id, title, heading, anchor, content FROM kb.chunks WHERE id = ANY(%s)",
                ([chunk_id for chunk_id, _ in fused],),
            )
        ).fetchall()
        by_id = {row[0]: row for row in rows}
        return [
            SearchHit(doc_id=r[1], title=r[2], heading=r[3], anchor=r[4], content=r[5], score=score)
            for chunk_id, score in fused
            if (r := by_id.get(chunk_id))
        ]
