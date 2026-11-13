# knowledge

Retrieval over the synthetic knowledge base (`data/kb`) for the `knowledge` skill (ADR 010).

## Exposed interface

- `knowledge_toolset(embedder, store)`: the `search_knowledge(query, k≤8)` tool (T0). Returns passages with
  `doc_id`, `title`, `section` and `anchor` for citations, filtered by `BotDeps.audiences`.
- `Embedder` protocol, `FastEmbedEmbedder`, `LazyEmbedder` (loads the model on first use).
- `KnowledgeStore` protocol and `PgKnowledgeStore` (pgvector + Spanish full text, fused with RRF).
- `Audience` (`public` | `customer`), used by `chat/deps.py`.
- `python -m app.knowledge.ingest` (`make ingest`): chunk one per `##` section, embed, replace the `kb` schema.

## Data flow

Question → `search_knowledge` → query embedding + full-text query → RRF over both candidate lists, audience
filtered in SQL → passages wrapped as untrusted data by the tool policy → the model answers and cites them.
Before ingest, or with no hits, the tool returns nothing and the skill answers "No tengo esa información".
