from collections.abc import Sequence

from pydantic_ai import Agent
from pydantic_ai.models.test import TestModel

from app.chat.deps import BotDeps
from app.knowledge.chunker import Audience, Chunk
from app.knowledge.search_tool import knowledge_toolset
from app.knowledge.store import SearchHit


class FakeEmbedder:
    dim = 3

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return [[0.0, 0.0, 1.0] for _ in texts]

    async def embed_query(self, text: str) -> list[float]:
        return [0.0, 0.0, 1.0]


class RecordingStore:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple[Audience, ...], int]] = []

    async def replace_all(self, chunks: Sequence[Chunk], embeddings: Sequence[list[float]], dim: int) -> None:
        raise NotImplementedError

    async def hybrid_search(
        self, query: str, query_embedding: list[float], audiences: Sequence[Audience], k: int
    ) -> list[SearchHit]:
        self.calls.append((query, tuple(audiences), k))
        return [SearchHit("comisiones", "Comisiones", "Internacionales", "internacionales", "US$ 25", 0.03)]


async def test_passes_the_callers_audiences_and_caps_k() -> None:
    store = RecordingStore()
    agent = Agent(TestModel(call_tools=["search_knowledge"]), deps_type=BotDeps)
    deps = BotDeps(user_id="ana", access_token="t", audiences=("public",))

    await agent.run("comisión", deps=deps, toolsets=[knowledge_toolset(FakeEmbedder(), store)])

    assert store.calls
    _, audiences, k = store.calls[0]
    assert audiences == ("public",)
    assert 1 <= k <= 8
