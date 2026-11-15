# Backlog

The POC's only task tracker: no GitHub Issues or Project board. One row per phase of
[`PLAN.md`](PLAN.md), plus follow-ups found along the way. What each phase built and verified is in
[`progress.md`](progress.md); this file says what's left and where things stand.

Status: `todo` · `in progress` · `in review` · `done` (merged to `main`).

## Phases

| Phase | Status | Branch / PR | Notes |
| --- | --- | --- | --- |
| 0 — Scaffold | done | PR #18 | Merged to `main` with all phases on 2026-11-15; the stacked PRs #13, #14, #16 and #17 were closed in favour of #18. |
| 1 — Streaming chat skeleton | done | PR #18 | Merged to `main` with all phases on 2026-11-15; the stacked PRs #13, #14, #16 and #17 were closed in favour of #18. |
| 2 — Domain tools over MCP | done | PR #18 | Merged to `main` with all phases on 2026-11-15; the stacked PRs #13, #14, #16 and #17 were closed in favour of #18. |
| 3 — RAG with citations | done | PR #18 | Merged to `main` with all phases on 2026-11-15; the stacked PRs #13, #14, #16 and #17 were closed in favour of #18. |
| 4 — Generative UI | done | PR #18 | Merged to `main` with all phases on 2026-11-15; the stacked PRs #13, #14, #16 and #17 were closed in favour of #18. |
| 5 — Approval and step-up | done | PR #18 | Merged to `main` with all phases on 2026-11-15; the stacked PRs #13, #14, #16 and #17 were closed in favour of #18. |
| 6 — Guardrails | done | PR #18 | Merged to `main` with all phases on 2026-11-15; the stacked PRs #13, #14, #16 and #17 were closed in favour of #18. |
| 7 — Resumable streams | done | PR #18 | Merged to `main` with all phases on 2026-11-15; the stacked PRs #13, #14, #16 and #17 were closed in favour of #18. |
| 8 — Evals and demo polish | done | PR #18 | Merged to `main` with all phases on 2026-11-15; the stacked PRs #13, #14, #16 and #17 were closed in favour of #18. |

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
| F40 | Cost: Anthropic prompt caching on the orchestrator (tool schemas, instructions, history; `PROMPT_CACHING` in `app/chat/agent.py`). Live `make eval` through the gateway: 85% of input tokens read from the cache (was 0%), 7/7 gates; `make metrics` reports the share. | done | Metrics review |
| F41 | `make metrics` reads failovers from the current bot container's logs only, so a restart (as `make failover-demo` does) loses them; read them from Phoenix spans (`bot.failovers`) instead. | todo | Failover demo |
| F42 | Scopes: the bot's `aud=mcp-gateway` token gets the full banking ceiling (`inheritSubjectScopes: false`) whatever skills are loaded, and the gateway asks each backend for its full ceiling. Request scopes by loaded skill at the bot hop (ADR 017's noted widening). | todo | P4–P8 review |
| F43 | Gateway cost: every `tools/list` re-exchanges a token and lists both backends, though the catalog doesn't depend on the customer; cache it with a TTL or refresh on a breaker transition. | todo | P4–P8 review |
| F44 | Gateway rate limit counts calls refused by an open breaker or failing upstream, so a customer retrying during an outage can be `rate_limited` once it recovers; count only forwarded calls. | todo | P4–P8 review |
| F45 | Gateway catalog: `loaded` turns true once any backend listed, so a backend down at the first refresh stays unknown to `tools/call` until a later `tools/list`; refresh when a name has no route and a backend never loaded. | todo | P4–P8 review |
| F46 | BFF `closeDanglingRun` reads the whole thread event log from seq 0 on every run; keep an "open run" key or read only the last event. | todo | P4–P8 review |
| F47 | Web reconnector: `attempt` resets whenever `connectAgent` resolves, so a restore failure CopilotKit reports after it returns retries at 500 ms forever; reset only after a stable period. | todo | P4–P8 confirming review |
| F48 | Web reconnector: the `online` watcher armed by `giveUp` stays armed after the chat recovers through a new run, so a later network blip calls `connectAgent` over a healthy run; disarm on any successful run. | todo | P4–P8 confirming review |
| F49 | Bot guard history re-derives pydantic-ai's `_take_new_turn` without its resubmission cut, so on an edit/regenerate the guard's evidence can include the discarded branch; take the history from the adapter's loaded conversation. | todo | P4–P8 confirming review |
| F50 | Reload transcript deep-copies the accumulated evidence per model response (quadratic in tool round-trips); build it only for responses with text. | todo | P4–P8 confirming review |
| F51 | Thread-log scrub (`logged-run-input.ts`) matches credential keys only on objects and parsed tool-message content: a `step_up_token` inside a JSON string elsewhere (e.g. `toolCalls[].function.arguments`) would still be logged. Match interrupt answers by toolCallId like the bot, and walk JSON strings. | todo | Confirming review |
| F52 | Refused-run save runs inside the pump task that `_stop` cancels after 2 s; a slow Postgres write loses the turn. A refused run with no `run_id` is silently not saved, and one whose last message is from an earlier run could overwrite that run's answer (`run_store.py`). | todo | Confirming review |
| F53 | `guardrails/history_guard.py` imports `skills.history` (not on its exposed interface) and derives `NON_EVIDENCE_TOOLS` from `SERVER_ONLY_TOOLS`, a set with a different meaning. | todo | Confirming review |
| F54 | `resume.spec.ts` flakes if the run finishes before the stream cut. | todo | Confirming review |
| F55 | Dependencies (pnpm audit 2026-11-15, all via CopilotKit 1.87): the 8 highs. undici and @fastify/busboy (BFF, under `@ai-sdk/google-vertex`) and graphql-scalars overridden to patched versions; zod 3.25.76's GHSA-mrhx-c7xc-m3w5 accepted (`@a2ui/web_core` 0.15 breaks on zod 4), with a 1 MiB body limit on the copilot route (ADR 019). Python (pip-audit): clean. | done | Dependency audit |
| F57 | Dependency follow-ups to F55: katex 0.16.47 (low, web, reachable through model markdown math, fix ≥0.18.2); `@hono/node-server` 1.19.19 inside the runtime (moderate, the BFF serves on its own 2.1.8); minimatch 10.2.6 (dev). Drop the zod ignore and the overrides per ADR 019's exit once CopilotKit or `@a2ui/web_core` moves. Hardening around ADR 019: a thread whose run body passes 1 MiB gets 413 on every later run and the web shows a generic error (handle it, or trim history); no concurrency or rate limit on the run route, so parallel bodies just under the cap still add up; one app-wide body limit in `app.ts` instead of the copilot route's own; a test that the BFF imports only `@copilotkit/runtime/v2` (the graphql-scalars 2 override relies on it). Dependabot alerts are disabled on the repo. | todo | Dependency audit |
| F56 | Security audit run 1 (quick, source-only) hardening: logout doesn't revoke the 30-min session JWT; `COOKIE_SECURE` defaults false; IdP token types share a key with no type claim; history restore mints a full `scope=chat` bot token; step-up lockout state is in memory; frequency caps keyed by client thread id; model-authored chip text counts as customer intent and can mimic the confirm card; `write_intent.py` doesn't escape its delimiters; Redis has no AUTH; compose gives every Node service every secret. Deferred units: CopilotKit `agent/suggest` bypassing the thread runner; whether the approved step-up token persists in the conversation store or output events. | todo | Security audit |
| F58 | Flaky e2e: `resume.spec.ts` "an offline blip mid-answer resumes" fails on desktop as the first spec after a BFF restart (it never catches a run stream to cut within 60 s), on main as well; it passes on re-run. | todo | Testing |
