"""`make ingest`: chunk data/kb, embed every chunk and replace the kb schema in Postgres."""

import asyncio
import logging
import sys
from pathlib import Path

from psycopg_pool import AsyncConnectionPool

from app.config import Settings
from app.core.logging import configure_logging
from app.knowledge.chunker import Chunk, chunk_doc
from app.knowledge.embedder import Embedder, FastEmbedEmbedder
from app.knowledge.store import KnowledgeStore, PgKnowledgeStore

logger = logging.getLogger(__name__)


def load_chunks(kb_dir: Path) -> list[Chunk]:
    return [chunk for path in sorted(kb_dir.glob("*.md")) for chunk in chunk_doc(path.read_text(encoding="utf-8"))]


async def ingest(kb_dir: Path, embedder: Embedder, store: KnowledgeStore) -> int:
    chunks = load_chunks(kb_dir)
    if not chunks:
        raise SystemExit(f"no markdown documents in {kb_dir}")
    embeddings = await embedder.embed_documents([chunk.embedding_text() for chunk in chunks])
    await store.replace_all(chunks, embeddings, embedder.dim)
    return len(chunks)


async def main() -> None:
    settings = Settings()
    configure_logging(settings.log_level)
    async with AsyncConnectionPool(settings.database_url, min_size=1, max_size=2, open=False) as pool:
        embedder = FastEmbedEmbedder(settings.embedding_model, settings.embedding_cache_dir)
        count = await ingest(settings.kb_dir, embedder, PgKnowledgeStore(pool))
    logger.info("ingested knowledge base", extra={"chunks": count, "model": settings.embedding_model})


if __name__ == "__main__":
    asyncio.run(main())
    sys.exit(0)
