from pydantic import BaseModel
from pydantic_ai import RunContext
from pydantic_ai.toolsets import FunctionToolset

from app.chat.deps import BotDeps
from app.knowledge.embedder import Embedder
from app.knowledge.store import KnowledgeStore
from app.policy.risk_tier import RISK_TIER_META_KEY

MAX_RESULTS = 8


class KnowledgeChunk(BaseModel):
    doc_id: str
    title: str
    section: str
    anchor: str
    content: str


def knowledge_toolset(embedder: Embedder, store: KnowledgeStore) -> FunctionToolset[BotDeps]:
    toolset: FunctionToolset[BotDeps] = FunctionToolset()

    @toolset.tool(metadata={"meta": {RISK_TIER_META_KEY: "T0"}})
    async def search_knowledge(ctx: RunContext[BotDeps], query: str, k: int = 4) -> list[KnowledgeChunk]:
        """Search the bank's knowledge base (fees, limits, schedules, cards, accounts, security).

        Returns passages with `doc_id`, `title` and `anchor`; cite the ones you use.
        """
        hits = await store.hybrid_search(
            query, await embedder.embed_query(query), ctx.deps.audiences, min(max(k, 1), MAX_RESULTS)
        )
        return [
            KnowledgeChunk(doc_id=h.doc_id, title=h.title, section=h.heading, anchor=h.anchor, content=h.content)
            for h in hits
        ]

    return toolset
