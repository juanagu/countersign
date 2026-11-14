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
| 7 — Resumable streams | in progress | `feat/p7-resumable-streams` | Redis-backed runner + Postgres history (ADR 015); Scenario 5 verified live and in tests; not reviewed yet. |
| 8 — Evals and demo polish | in review | `feat/p8-evals-demo` | Live `make eval` (golden scenarios, KB grounding, tool selection, LLM judge, red team) gated by `thresholds.yaml`; `make metrics`; `docs/DEMO.md` (ADR 016). Passed from a clean clone; not reviewed yet. |

## Follow-ups

| # | Item | Status | Source |
| --- | --- | --- | --- |
| F1 | BFF: resolve the session once per runtime request (it is verified three times; an expiry in between gives a 500 instead of a 401). Cache the verified claims per `Request`. | todo | Phase 1 review |
| F2 | Mock IdP: revoke the session on logout (stateless JWT stays valid up to 30 min). A `jti` denylist in Redis until `exp`. | todo | Phase 1 review |
| F3 | Contracts: avoid `export *` collisions in the generated index once two schemas share a `$ref`. | todo | Phase 1 review |
| F4 | `mcp-payments`: enforce the ARS 5.000.000 daily transfer limit the KB states. | todo | Phase 2–3 review |
| F5 | Config: `z.url()` accepts `localhost:3000/x` (reads `localhost:` as a scheme); restrict service URLs to http(s). | todo | Phase 2 fixes |
| F6 | Bot: wrap MCP error results as untrusted data too, like successful ones. | todo | Phase 2 fixes |
| F7 | See the UI in a real browser: `pnpm --dir apps/web test:e2e` with the stack up, plus screenshots at 390 and 1280. Automation here could not capture screenshots. | done: 14/14 e2e at 390 and 1280, screenshots taken | Phases 1, 4, 5 |
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
| F23 | Resumable streams: browser check of the offline toggle and reload (`apps/web/e2e/resume.spec.ts`, written, never run). | done: passes at both widths | Phase 7 |
| F24 | BFF runner: make `stop` reach a run on another BFF replica (Redis pub/sub), and let a run outlive its BFF process (the bot writing the log, as the plan first proposed). | todo | Phase 7 |
| F25 | Restore past the replay window: keep the cards (template/A2UI activity) and a pending approval, e.g. by persisting the display transcript with the conversation. | todo | Phase 7 |
| F26 | Thread log size: `RUN_STARTED` carries the client's whole message list on every run; store only the new turn and rebuild earlier turns from the previous runs. | todo | Phase 7 |
| F27 | Demo in a real browser: walk `docs/DEMO.md` at 5173, including the DevTools Offline toggle and reload (Scenario 5) and the PIN dialog; only its HTTP equivalent was run. | done: `pnpm --filter web test:e2e` covers all five scenarios at 1280 and 390 against the live stack, 14/14 | Phase 8 |
| F28 | Knowledge skill: the model often puts the KB answer on a card and writes only "te dejé el detalle en la tarjeta". Decide whether the answer belongs in the text (skill wording) and add an eval check for it. | done: skills answer in text first; the output guard shows model cards after the text; `AnswersInText` eval gate | Phase 8 |
| F29 | Evals: a `make eval` run costs real tokens and resets the shared bank data (`make seed`). Give it its own database or schema so it can run while a demo is open. | todo | Phase 8 |
| F30 | Metrics: tokens per run counts only pydantic-ai `chat` spans in the bot; the red-team judge and the eval judge run outside the stack and are not counted. Add cost per run (`operation.cost`) to `make metrics`. | todo | Phase 8 |
| F31 | Spending card repeats the same numbers as bars and as a full list, with lowercase category names; the spending skill should ask for one or the other, and categories should be display-cased. | done: spending is bars only, categories display-cased in CSS; `SpendingMatches` fails on a repeated list | Phase 8 |
| F32 | Confirm card keeps saying "Transferencia por confirmar" and its expiry after the receipt appears; mark it as sent (or collapse it) once the transfer executes. | done: redesign slice 2: the confirm card collapses to one line once confirmed, cancelled or expired | Phase 8 |
| F33 | One mobile e2e run of the resume spec saw no assistant text within 30 s (the run stayed busy); four reruns passed. Watch for a stall at run start before the first token. | todo | Phase 8 |
| F34 | Reload past the 15-minute replay window restores text and the confirm/receipt cards, not A2UI surfaces (charts, sources): the stored copy predates the output guard. Store the guard's verdict (or the streamed surface) so they can come back too. | todo | Phase 8 |
| F35 | Chat redesign (artboard approved by the user): slice 1 (tokens, Instrument Sans, cards, Money, welcome tiles, header, PIN sheet) and slice 2 (approval inside the confirm card, chips, connection pill, tool status line, run error notice). | done on `feat/p8-evals-demo`, not reviewed | UX request |
| F36 | MCP gateway (ADR 017): the bot reaches every banking tool through `services/mcp-gateway` (port 8100); the IdP no longer issues the bot backend tokens and the backends accept only the chain `[mcp-gateway, bot]`. Security rule 1 reworded. Follow-up: narrow the gateway token's scopes by loaded skill. | done | Gateway request |
| F37 | LLM failover (ADR 018): built and demoed live. Backup mode gets its own quality gate, 0.70 (`thresholds.yaml` `backup_mode`); Anthropic only; failover stays invisible to the customer. | done | Gateway request |
| F38 | Resolved-state lines "venció sin confirmarse" and resume-failed are only unit-tested; `resumeFailed` is one global flag, so every unresolved confirm card shows it until the next run. | todo | Slice 2 |
| F39 | The fallback-draft card and the run-error notice share CopilotKit's `setInterruptElement` slot; if both are active the last one wins. | todo | Slice 2 |
| F40 | Cost: requests send ~5.3k input tokens each with no prompt caching (`cache_read_tokens` is 0). Cache the system prompt, skills and tool schemas (Anthropic prompt caching through pydantic-ai model settings) and report cache hits in `make metrics`. | todo | Metrics review |
| F41 | `make metrics` reads failovers from the current bot container's logs only, so a restart (as `make failover-demo` does) loses them; read them from Phoenix spans (`bot.failovers`) instead. | todo | Failover demo |
