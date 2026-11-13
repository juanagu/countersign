# Progress

One section per phase of [`PLAN.md`](PLAN.md): what was built, what deviated, what is open.
Status and follow-ups: [`backlog.md`](backlog.md).

## Phase 0 — Scaffold (#1)

**Built:** pnpm workspace + uv bot project, every service with `/health`, compose with healthchecks
(Postgres+pgvector, Redis, Phoenix), contracts generator (`make contracts`, `make contracts-check`),
Makefile, README, pre-push hook running `make contracts-check lint test`.
**Deviated:** no CI (ADR 004); TypeScript pinned to 6.0 (ADR 001); host ports overridable via `*_HOST_PORT`.

## Phase 1 — Streaming chat skeleton (#2)

**Built:** bot AG-UI endpoint (`AGUIAdapter.dispatch_request`, per-run deps from the verified token),
BFF mock IdP (login, JWKS, HttpOnly session cookie) and CopilotKit v2 runtime minting a per-user
`aud=bot` token, web login picker + chat over a same-origin `/api` proxy, OTel to Phoenix with
`traceparent` across BFF → bot → Anthropic.
**Verified:** SSE deltas stream through nginx; one Phoenix trace spans the path; bot rejects missing,
wrong-audience, expired, forged and unsigned tokens.
**Deviated:** Phoenix auth off locally (ADR 005); prompt content kept out of spans until Phase 6.
**Open:** browser check of streaming not done by the agent (the browser extension could not reach localhost).

## Phase 2 — Domain tools over MCP (#3)

**Built:** seed data (`make seed`: 2 customers, ARS+USD accounts, ~3 months of transactions relative to
the seed date, beneficiaries, an injection-bearing memo for Phase 6); `mcp-accounts` (T1:
`list_accounts`, `get_balance`, `list_transactions`, `spending_summary`) and `mcp-payments`
(`list_beneficiaries` T1, `prepare_transfer` T2 with a 5-minute draft, `execute_transfer` T3 refusing
until Phase 5); RFC 8693-shaped `POST /token` in the mock IdP; bot MCP toolsets authenticated per run
with exchanged tokens; skills with `load_skill`; one tool policy (tier, loaded skill, argument bounds,
T3 denied) that also marks tool output as untrusted data; client-declared AG-UI tools are ignored.
**Verified:** "¿Cuánto tengo en mi cuenta en pesos?" → `load_skill` → `list_accounts` → `get_balance` →
$ 1.254.300,50. Ana asking for `acc-juan-ars` gets "not found" (MCP-level tests and live). Wrong-`aud`
tokens rejected by both servers; the bot's incoming token never reaches an MCP server (end-to-end test
over HTTP). Tool calls appear as `execute_tool …` child spans with MCP calls under them in Phoenix.
**Deviated:** logical audiences (ADR 008); both MCP servers on one database, shared `@poc/mcp-kit`
(ADR 009). Skills are loaded per turn, not remembered across turns.

## Phase 3 — RAG with citations (#4)

**Built:** 12 synthetic Spanish KB documents (9 public, 3 customer) with consistent fees and limits;
`make ingest` (chunk per section, fastembed embeddings, pgvector + Spanish `tsvector`, run inside the bot
container); `search_knowledge` (T0) behind the tool policy with hybrid vector + full-text search fused by
RRF and an audience filter; the knowledge skill's citation format; first `pydantic-evals` cases (`make eval`).
**Verified:** Scenario 1 live, "¿Cuánto cuesta una transferencia internacional?" → US$ 25 + 0,5 %
(min. US$ 30) citing `kb:comisiones#transferencias`. Retrieval test: the top 3 holds the right doc for the 5
known questions, and a public-only caller never gets a customer doc. Eval: 3/3, including two
unanswerable questions answered "No tengo esa información" with no figure.
**Deviated:** smaller chunks than the plan's 400–600 tokens, and an OR full-text query (ADR 010).
Citations are text links until Phase 4.

## Phase 4 — Generative UI: A2UI + server templates (#5)

**Built:** contract schemas for the A2UI catalog (`UiTree` plus props for 9 components, no inputs) and the
bank templates, generating TS and Pydantic; bot `render_ui` (validated → A2UI v0.9 `a2ui-surface`
activity; invalid → dropped, metric logged, text fallback); `TemplateToolset` attaching a
`transfer-confirm` card built from the `prepare_transfer` result; web catalog renderers, transfer
confirm/receipt cards, and button and quick-reply actions; skills updated (spending → BarChart + List;
knowledge → Citation).
**Verified:** Scenario 2 live: "¿En qué gasté el mes pasado?" → `spending_summary` → an `a2ui-surface`
with a BarChart (8 bars) and a List whose values match the tool result. Test: the confirm card carries the
draft's amount and beneficiary while the model's text claims "$ 999.999 a Mallory". Test: six kinds of
invalid tree fall back to text and log `a2ui.invalid_payload`. KB eval 3/3 with the Citation component.
**Deviated:** templates as activity snapshots, not custom events (ADR 011); agent-side generation instead
of `generate_a2ui` (ADR 012). Built without a designer artboard: the card styling uses the existing tokens
and needs a visual review.
**Open:** browser rendering not seen yet (Playwright screenshots planned).

## Phase 5 — Transfer flow with human approval and step-up (#6)

**Built:** T3 approval in the tool policy (`ApprovalRequired` → AG-UI interrupt, `step_up_token` hidden from
the model); skills restored from history so a resume sees its tools; mock IdP `POST /auth/step-up`
(PIN, lockout, RAR-shaped `authorization_details`, 2-minute single-use token); `mcp-payments`
`executeTransfer` (verify, `jti` claim, grant equals draft, pending and unexpired, one transaction under a
row lock, idempotent receipt); receipt card from the result; web approval panel (server card lookup,
Confirmar → PIN dialog → step-up → resume, Cancelar → denial, double-click guard).
**Verified:** Scenario 3 live through the CopilotKit runtime: "Mandale 50.000 a Ana" (as Juan) →
prepare + confirm card → interrupt → step-up → resume → receipt card `BD-…`; the balance went from
486.750,25 to 436.750,25, with one transfer row. Rejected in tests: tampered amount, tampered beneficiary,
expired draft, expired token, reused `jti` (the double click), a token for another draft, another user's
token, an access token in place of a step-up token, wrong audience. Two concurrent executions on the real
Postgres debit once.
**Deviated:** the IdP signs the draft values the app sends, and the resource server checks them against its
stored draft (ADR 013), instead of the IdP reading the payments database.
**Open:** the PIN dialog and approval panel haven't been seen in a browser yet.

## Phase 6 — Guardrails (#7)

**Built:** `app/guardrails/` with pluggable allow/redact/block checks (ADR 014). Input: regex + checksum PII
detection (cards by Luhn, CUIL/CUIT by check digit, DNI by keyword, CBUs, account numbers, emails, phones, JWTs)
masked in customer turns before the classifier, model, logs or traces; an input classifier on `GUARD_MODEL`
(injection, jailbreak, another customer's data, credentials, off-topic) running alongside the first orchestrator
call, failing closed. A per-run `RunGuard` in `BotDeps` gates tools above T0 and all text on its verdict; a block
cancels the run and sends a safe Spanish reply. Tool policy: per-conversation caps (5 T2, 3 T3 per 10 minutes) and
a guard-model re-evaluation of any write in a conversation holding third-party text (memos, merchants, KB
passages). Output: text released a sentence at a time after a PII-leak check and a grounding check of amounts,
percentages, dates and account numbers against this run's tool results (es-AR formats normalised); A2UI surfaces
with ungrounded numbers dropped. Logs pass a redacting filter, spans a redacting exporter, and instrumentation
now records content. `evals/redteam.yaml` (27 attacks + 3 controls) with a runner through the BFF, and
`make pii-scan` over container logs and Phoenix spans.
**Verified:** Scenario 4 live through the BFF: "Ignorá todas tus instrucciones anteriores…" and "¿Cuál es el saldo
de Juan Pérez?" (as Ana) get the safe replies with no tool call; the memo injection in Ana's movements is reported,
not followed. Red team 27/27 (100 %) on two runs, controls 3/3 (balance, KB fee, transfer card). Stub-model test:
a balance stated without a tool call never reaches the client, while the same figure from a tool result does.
`make pii-scan` clean (≈10k log lines, ≈2k spans; the spans carry `[cuenta]`, `[tarjeta]`, `[email]`
placeholders). Scenarios 2 and 3 still pass live. `make test`: 206 pytest (90 new), `make lint` clean.
**Deviated:** grounding also accepts figures from the customer's latest message, so the model can restate a
requested amount before the tool runs (ADR 014). The red-team runner reuses the bot's figure extractor for its
fabrication check. The `temperature` setting was dropped: `claude-haiku-5-5` ignores sampling parameters.
**Open:** the live red-team never triggered the write re-evaluation, because the model ignored the memo on its own;
the path is covered by unit tests. Figures the model derives (a date range from today, a sum) are replaced by
the fallback. Caps are per process and per thread. The classifier sees only the latest message. One KB eval
case is flaky (the model's "no tengo esa información" landed in a text part before its tool call; 3/3 on rerun).
