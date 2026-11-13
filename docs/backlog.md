# Backlog

The POC's only task tracker: no GitHub Issues or Project board. One row per phase of
[`PLAN.md`](PLAN.md), plus follow-ups found along the way. What each phase built and verified is in
[`progress.md`](progress.md); this file says what's left and where things stand.

Status: `todo` · `in progress` · `in review` · `done` (merged to `main`).

## Phases

| Phase | Status | Branch / PR | Notes |
| --- | --- | --- | --- |
| 0 — Scaffold | in review | `feat/p0-scaffold`, PR #13 | Reviewed together with Phase 1. |
| 1 — Streaming chat skeleton | in review | `feat/p1-streaming-chat`, PR #14 | Converged: high pass (10 fixed), medium pass (7 small fixed). |
| 2 — Domain tools over MCP | in review | `feat/p2-mcp-tools`, PR #16 | Converged after a high pass and three medium passes. |
| 3 — RAG with citations | in review | `feat/p3-rag`, PR #17 | Reviewed with Phase 2. |
| 4 — Generative UI | in progress | `feat/p4-genui` | Built, verified at the event level; not reviewed yet. |
| 5 — Approval and step-up | in progress | `feat/p5-approval` | Scenario 3 verified live; not reviewed yet. |
| 6 — Guardrails | in progress | `feat/p6-guardrails` | Being built. |
| 7 — Resumable streams | todo | — | CopilotKit's built-in resume is unreliable after a mid-stream disconnect; build a Redis-backed runner in the BFF. |
| 8 — Evals and demo polish | todo | — | `make eval` already runs the KB cases; red-team set lands in Phase 6. |

## Follow-ups

| # | Item | Status | Source |
| --- | --- | --- | --- |
| F1 | BFF: resolve the session once per runtime request (it is verified three times; an expiry in between gives a 500 instead of a 401). Cache the verified claims per `Request`. | todo | Phase 1 review |
| F2 | Mock IdP: revoke the session on logout (stateless JWT stays valid up to 30 min). A `jti` denylist in Redis until `exp`. | todo | Phase 1 review |
| F3 | Contracts: avoid `export *` collisions in the generated index once two schemas share a `$ref`. | todo | Phase 1 review |
| F4 | `mcp-payments`: enforce the ARS 5.000.000 daily transfer limit the KB states. | todo | Phase 2–3 review |
| F5 | Config: `z.url()` accepts `localhost:3000/x` (reads `localhost:` as a scheme); restrict service URLs to http(s). | todo | Phase 2 fixes |
| F6 | Bot: wrap MCP error results as untrusted data too, like successful ones. | todo | Phase 2 fixes |
| F7 | See the UI in a real browser: `pnpm --dir apps/web test:e2e` with the stack up, plus screenshots at 390 and 1280. Automation here could not capture screenshots. | todo | Phases 1, 4, 5 |
| F8 | Visual review of the card, chart and approval styling (built from existing tokens, no designer artboard). | todo | Phase 4 |
| F9 | Knowledge search: degrade to "no tengo esa información" on any store or embedder failure (Postgres down, an embedding dimension mismatch), not only before ingest. | todo | Phase 2–3 review 3 |
| F10 | `mcp-kit`: report a JWKS fetch failure as a server error (503), not `invalid_token`. | todo | Phase 2–3 review 3 |
| F11 | Retrieval test skip guard: check `count > 0` (`fetchone()` is always truthy). | todo | Phase 2–3 review 3 |
| F12 | Transfer limits: one source for the bot policy, `mcp-payments` and the KB (a contract constant). | todo | Phase 2–3 review 3 |
| F13 | Cleanups: run hybrid search in one SQL statement (RRF in CTEs); move the MCP test client and account masking into `@poc/mcp-kit`; stop building a full `McpServer` per HTTP message. | todo | Phase 2–3 review 3 |
| F14 | Chunker: when splitting an oversized section, don't repeat the overlap when overlap + next paragraph overflows (latent: largest section today is 215 tokens). | todo | Phase 2–3 review 4 |
| F15 | `mcp-kit` route: answer 405 to GET/DELETE in stateless mode and close server/transport after each request. | todo | Phase 2–3 review 4 |
| F16 | Bot: log a failed embedder warm-up (done-callback) so a missing model shows before the first question. | todo | Phase 2–3 review 4 |
| F17 | Bot: derive which skills open which MCP server from the skill files instead of `SKILLS_BY_AUDIENCE`. | todo | Phase 2–3 review 4 |
| F18 | Bot tests: check the fake MCP servers' tool names, args and tier meta against the real servers' `tools/list` (standards: a double is checked against the real boundary). | todo | Phase 2–3 review 4 |
| F19 | Bot guardrails: merge the three JSON walkers (`pii.redact_value`, `output_guard.redact_surface`, `grounding._surface_values`) into one. | todo | Phase 6 review |
| F20 | Web genui: stop using model-written labels as React keys in `KeyValueListView` and `QuickRepliesView` (duplicates collide). | todo | Phase 6 review |
| F21 | Bot policy: fold `_require_approval`'s two identical `ApprovalRequired` branches into one condition. | todo | Phase 6 review |
| F22 | Bot policy: `FrequencyCaps.acquire` prunes every key on each call; prune only the key it counts, or sweep on a timer. | todo | Phase 6 review |
