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
| 2 — Domain tools over MCP | in review | `feat/p2-mcp-tools` | Two review rounds fixed (21 findings); final medium pass running. PR after it converges. |
| 3 — RAG with citations | in review | `feat/p3-rag` | Reviewed with Phase 2. |
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
