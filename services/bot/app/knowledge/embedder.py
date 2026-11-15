import asyncio
from collections.abc import Sequence
from typing import Protocol

DEFAULT_EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"


class Embedder(Protocol):
    """Turns text into vectors. Swappable (e.g. Voyage AI) without touching ingest or search."""

    @property
    def dim(self) -> int: ...

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]: ...

    async def embed_query(self, text: str) -> list[float]: ...


class LazyEmbedder:
    """Builds the real embedder on first use, so startup (and /health) does not wait for a model download."""

    def __init__(self, factory: "type[FastEmbedEmbedder]", model_name: str, cache_dir: str | None):
        self._factory, self._model_name, self._cache_dir = factory, model_name, cache_dir
        self._embedder: FastEmbedEmbedder | None = None
        self._lock = asyncio.Lock()

    async def _get(self) -> "FastEmbedEmbedder":
        async with self._lock:
            if self._embedder is None:
                self._embedder = await asyncio.to_thread(self._factory, self._model_name, self._cache_dir)
            return self._embedder

    @property
    def dim(self) -> int:
        if self._embedder is None:
            raise RuntimeError("embedder not loaded yet")
        return self._embedder.dim

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return await (await self._get()).embed_documents(texts)

    async def embed_query(self, text: str) -> list[float]:
        return await (await self._get()).embed_query(text)

    async def warm_up(self) -> None:
        await self._get()


class FastEmbedEmbedder:
    """Local multilingual embeddings (fastembed, ONNX). Inference is CPU-bound, so it runs off the event loop."""

    def __init__(self, model_name: str = DEFAULT_EMBEDDING_MODEL, cache_dir: str | None = None):
        from fastembed import TextEmbedding

        self._model = TextEmbedding(model_name=model_name, cache_dir=cache_dir)
        self._dim = len(next(iter(self._model.embed(["dim"]))))

    @property
    def dim(self) -> int:
        return self._dim

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return await asyncio.to_thread(lambda: [v.tolist() for v in self._model.embed(list(texts))])

    async def embed_query(self, text: str) -> list[float]:
        vectors = await self.embed_documents([text])
        return vectors[0]
