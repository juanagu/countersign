# 010 — Embedding model, chunk size and hybrid search

## Context
Anthropic has no embeddings API; the brief asks for a local multilingual model via fastembed behind an
interface. The synthetic KB is 12 short documents (~450 words each).

## Decision
- **Model:** `sentence-transformers/paraphrase-multilingual-mpnet-base-v2` (768 dims, ~1 GB), set by
  `EMBEDDING_MODEL`. `multilingual-e5-large` (1024 dims) needs ~2.2 GB of RAM in the bot container beside
  the rest of the stack, and the smaller MiniLM missed more of the known questions. The model is cached in
  the `models` volume and loaded lazily, so `/health` never waits for a download.
- **Chunks:** one per `##` section, never merged, so a citation's heading and anchor always name the
  section the text came from (merging small neighbours under the first heading cited the wrong one). The
  intro before the first `##` is a chunk under the doc title. A hard cap of 600 tokens, with paragraph
  overlap, splits a longer section. The plan's 400–600 target would make one chunk per
  document here: with whole-document chunks the PIN question missed the security policy in the top 3.
- **Search:** vector (cosine, HNSW) and Spanish full-text each return 20 candidates, fused with
  reciprocal rank fusion (k=60), filtered by audience in both queries. The full-text query ORs the
  question's lexemes (`plainto_tsquery` with `&` → `|`), because requiring every lexeme left the
  keyword retriever empty for full-sentence questions.
- **Citations:** until the Phase 4 `Citation` component, answers end with
  `Fuentes: [Título — Sección](kb:doc_id#anchor)`.

## Consequences
`make ingest` replaces the `kb` schema each run. Changing the model means re-ingesting (the vector
dimension follows the embedder). The `Embedder` protocol is the swap point for Voyage AI.
