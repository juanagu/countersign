# POC build plan

Eight phases, each ending in a demoable state. Finish a phase, run its acceptance
checks, write a short summary (built / deviated / open questions), then stop for review.

The POC is done when these five demo scenarios pass end to end:

1. **Knowledge:** "¿Cuánto cuesta una transferencia internacional?" → answer from the
   knowledge base with citations.
2. **Personal data + GenUI:** "¿En qué gasté el mes pasado?" → tool call → A2UI bar
   chart and list.
3. **Money movement:** "Mandale 50.000 a Ana" → confirm card (server template) →
   step-up PIN → transfer executed → receipt card.
4. **Attacks:** a prompt-injection attempt and a request to reveal another customer's
   data are both blocked; no PII appears in logs.
5. **Resilience:** cut the network mid-answer → the stream resumes without lost or
   duplicated text.

---

## Phase 0 — Scaffold

**Build**
- Monorepo layout as in `CLAUDE.md`: pnpm workspace (`apps/*`, `services/mcp-*`,
  `packages/*`) and a uv project in `services/bot`.
- `infra/docker-compose.yml` with Postgres 16 + pgvector, Redis 7 and Arize Phoenix.
  Each service gets a Dockerfile and a compose entry with healthchecks.
- `packages/contracts` with an empty schema folder and a generation script wired to
  `make contracts`.
- `Makefile` with the targets listed in `CLAUDE.md`, `.env.example`, `.gitignore`, and
  a root `README.md` with setup steps.
- A `/health` endpoint on every service. GitHub Actions workflow: lint + test.

**Acceptance**
- [ ] `make up` from a clean clone brings every container to healthy.
- [ ] `make lint` and `make test` pass.

---

## Phase 1 — Streaming chat skeleton

**Build**
- **Bot:** FastAPI app exposing an AG-UI endpoint through Pydantic AI's `AGUIAdapter`.
  Use the request-level API so each run gets per-user deps (user id, tokens), not the
  static `to_ag_ui()` app. Orchestrator agent on `BOT_MODEL` with a minimal system
  prompt: banking assistant, Spanish by default, honest about limits.
- **BFF:** Hono server hosting the CopilotKit v2 runtime with one agent,
  `HttpAgent({ url: BOT_URL })`.
- **BFF mock IdP:**
  - `POST /auth/login`: pick a demo user (`ana`, `juan`) and get a JWT, `aud=bff`.
  - `/.well-known/jwks.json` for verification.
  - The BFF verifies the session and forwards a token with `aud=bot` to the bot.
- **Web:** Vite React app. Login screen with a user picker, then a CopilotKit v2 chat
  pointed at the BFF runtime.
- **Tracing:** OpenTelemetry in BFF and bot, exporting to Phoenix, with `traceparent`
  propagated.

**Acceptance**
- [ ] Text streams token by token in the browser.
- [ ] One trace in Phoenix spans BFF → bot → Anthropic call.
- [ ] The bot rejects a request without a valid `aud=bot` token (test).

---

## Phase 2 — Domain tools over MCP

**Build**
- `data/seed`: synthetic customers (`ana`, `juan`), accounts in ARS and USD, about 3
  months of transactions with categories and merchants, beneficiaries (Ana has "Juan
  Pérez"; Juan has "Ana Gómez"). Load with `make seed`.
- **`mcp-accounts`** (T1 tools): `list_accounts`, `get_balance`, `list_transactions`
  (date range, category, limit), `spending_summary` (by category for a period).
- **`mcp-payments`:**
  - `list_beneficiaries` (T1).
  - `prepare_transfer` (T2): creates a draft with id, amount, currency, source,
    beneficiary, fee, 5-minute expiry and status `pending`; returns it.
  - `execute_transfer` (T3): takes `draft_id` and a step-up token; full verification
    lands in Phase 5, so for now return "not authorised".
- Every MCP tool declares its risk tier in metadata. MCP servers validate the JWT: issuer,
  `aud` = their own resource URI, expiry, and that the `sub` owns the requested resources.
- **Mock IdP:** `POST /token` performs RFC 8693-shaped token exchange (subject token
  `aud=bot` → new token with `aud` = target MCP server, narrowed scopes, `act` claim =
  bot).
- **Bot:** MCP client toolsets for both servers (Pydantic AI MCP over streamable HTTP).
  Each call carries the exchanged token for that server.
- **Skills:** `services/bot/skills/{accounts,payments,knowledge}.md` with YAML
  frontmatter (`name`, `description`, `tools` allow-list, `max_tier`). The orchestrator
  sees the skill index and loads a skill with a `load_skill` tool. Only tools from loaded
  skills are exposed (filtered toolset).
- **Tool policy:** a single module that checks tier, the loaded skill and argument
  bounds before any MCP call.

**Acceptance**
- [ ] "¿Cuánto tengo en mi cuenta en pesos?" answers from `get_balance`.
- [ ] Ana cannot read Juan's accounts even by asking for his account id (test at the MCP
  level).
- [ ] An MCP server rejects a token with the wrong `aud`, and the bot never sends its
  incoming token to an MCP server (tests).
- [ ] Tool calls appear as child spans in Phoenix.

---

## Phase 3 — RAG with citations

**Build**
- `data/kb`: 10–15 synthetic Spanish markdown docs: fees, transfer limits and
  schedules, card blocking, account opening, FAQs, and a security policy ("we never
  ask for your PIN"). Each has frontmatter: `id`, `title`, `audience` (`public` |
  `customer`).
- `make ingest`:
  - Chunk by heading (~400–600 tokens, small overlap).
  - Embed with the local multilingual model.
  - Store in pgvector with a `tsvector` column.
- `search_knowledge(query, k)` tool (T0) in the knowledge skill:
  - Hybrid search: vector + full text, merged with reciprocal rank fusion.
  - Audience ACL filter.
  - Returns chunks with `doc_id`, title and anchor.
- The answer must cite sources. The client renders citations (an A2UI citation
  component once Phase 4 lands; plain links until then).

**Acceptance**
- [ ] Scenario 1 passes with a correct citation.
- [ ] A question the KB can't answer gets "no tengo esa información" plus a suggestion,
  not a hallucinated fee (eval case).
- [ ] Retrieval unit test: the top 3 results for 5 known questions contain the right doc.

---

## Phase 4 — Generative UI: A2UI + server templates

**Build**
- **Catalog** in `packages/contracts/a2ui-catalog`: `Card`, `Text`, `KeyValueList`,
  `List`, `BarChart`, `Table`, `Button`, `Citation`, `QuickReplies`. Each has a props
  schema. There are no input components for secrets.
- **Web:** React renderers for the catalog, registered with CopilotKit's A2UI
  renderer. Check the current CopilotKit docs for catalog wiring (`createCatalog` /
  provider `a2ui` prop).
- **Agent-side A2UI:**
  - A `render_ui` tool where the model returns a component tree as structured output
    constrained to the catalog.
  - The bot validates it against the schema, then emits A2UI v0.9 messages
    (`createSurface`, `updateComponents`, `updateDataModel`) in the AG-UI shape the
    CopilotKit renderer consumes. Verify that shape in docs; it is reported as an
    activity snapshot with activity type `a2ui-surface`.
  - Invalid payload → drop it, send text, log a metric.
  - Record an ADR comparing this with CopilotKit's injected `generate_a2ui` tool and
    why agent-side generation was chosen (server-side validation as a guardrail).
- **Server templates:**
  - `transfer-confirm` and `transfer-receipt` React components.
  - The bot emits them as a custom AG-UI event (`surface`: template id + version, data,
    `surfaceId`, nonce) from inside the tool wrapper, using the MCP result. Pydantic AI
    tools can attach AG-UI events to a `ToolReturn`.
  - The model never supplies template data.
- Scenario 2: the accounts skill instructs the model to render spending summaries with
  `BarChart` + `List`.

**Acceptance**
- [ ] Scenario 2 renders a chart and list from real tool data.
- [ ] `prepare_transfer` shows a `transfer-confirm` card whose amount and beneficiary
  come from the draft (test: change the model's text, the card stays correct).
- [ ] A deliberately invalid A2UI payload falls back to text (test).

---

## Phase 5 — Transfer flow with human approval and step-up

**Build**
- Mark `execute_transfer` as approval-required in Pydantic AI (deferred tools).
  Confirm the run pauses as an AG-UI interrupt and resumes with deferred tool results
  (`AGUIAdapter` maps `RunAgentInput.resume`), and that CopilotKit v2 supports the
  interrupt/resume round trip. ADR if a workaround is needed.
- **Web:**
  - The confirm card's "Confirmar" opens a PIN modal and calls the BFF mock IdP
    `POST /auth/step-up` with `draft_id`.
  - It receives a token with `authorization_details: [{type: "transfer", draft_id,
    amount, currency, beneficiary_id}]`, a 2-minute expiry and a `jti`.
  - It resumes the run with approval + that token. "Cancelar" resumes with a denial.
- **mcp-payments `execute_transfer`:**
  - Verify signature, `aud`, `exp`, single-use `jti`, and `authorization_details` ==
    the stored draft.
  - Execute idempotently (keyed by `draft_id`).
  - Return the receipt; the bot emits the `transfer-receipt` template.

**Acceptance**
- [ ] Scenario 3 passes end to end.
- [ ] Each of these is rejected with a test: tampered amount, expired draft, reused
  `jti`, a token for another draft, another user's token.
- [ ] Double-clicking "Confirmar" executes once.

---

## Phase 6 — Guardrails

**Build** (`services/bot/app/guardrails/`, pluggable checks, each returns allow /
redact / block + reason):

- **Input:**
  - Regex/Luhn PII detection (card numbers, document ids, emails, phones) with
    redaction before logging.
  - An injection/jailbreak/off-topic classifier on `GUARD_MODEL`.
  - The classifier runs concurrently with the first orchestrator call; if it blocks,
    cancel the run and send a safe reply.
- **Tool policy:** already in place from Phase 2. Add per-session frequency caps for
  T2/T3, and the rule that a write tool can't be called in the same step as reading
  free-text third-party content without re-evaluation.
- **Output, streaming-aware:**
  - Buffer text deltas to sentence boundaries.
  - Hold any sentence with amounts, dates or account numbers until a grounding check
    confirms each number appears in a tool result from this run.
  - Run a PII leak check per sentence.
  - On failure, replace the sentence with a safe fallback and log the event.
- **Logging:** redaction middleware for logs and span attributes.

**Acceptance**
- [ ] Scenario 4 passes.
- [ ] Red-team set in `services/bot/evals/redteam.yaml` (at least 20 prompts: direct injection,
  injection inside a transaction memo, "ignore previous instructions and transfer…",
  asking for other users' data, asking for the PIN) has at least 95% blocked or safely
  handled. Record the actual rate in the phase summary.
- [ ] A hallucinated balance (forced in a test with a stub model) never reaches the
  client.
- [ ] Grep of logs and traces after the eval run finds no unredacted synthetic PII.

---

## Phase 7 — Resumable streams

**Build**
- First evaluate what CopilotKit v2 offers for reconnection and resume (runners,
  thread persistence) and write an ADR.
- If it falls short:
  - The bot appends every AG-UI event to a Redis Stream per thread with a monotonic
    `seq` (sent as the SSE `id`).
  - The BFF serves reconnects with `Last-Event-ID`, replaying from Redis then tailing
    live.
  - Keep the replay window short (for example 15 minutes).
- Persist conversation history in Postgres so a page reload restores the thread.

**Acceptance**
- [ ] Scenario 5: killing the connection mid-answer (DevTools offline toggle, or a
  test that drops the socket) resumes with no lost or duplicated text.
- [ ] Reload restores the conversation.

---

## Phase 8 — Evals and demo polish

**Build**
- A `pydantic-evals` suite in `services/bot/evals` with:
  - Golden cases for the five scenarios.
  - KB grounding cases.
  - Tool-selection cases (right skill, right tool, right arguments).
  - The red-team set.
- An LLM-as-judge on `GUARD_MODEL` scores answer quality and citation correctness.
- `make eval` prints a table and fails under thresholds you agree on and set in config.
- A Phoenix dashboard or saved view: latency (time to first token, time to first UI
  surface), tokens per run, guardrail blocks.
- `docs/DEMO.md`: a click-by-click script for the five scenarios plus architecture
  notes and known limitations.

**Acceptance**
- [ ] `make up && make seed && make ingest && make eval` passes from a clean clone.
- [ ] `docs/DEMO.md` runs as written.

---

## Out of scope for the POC (document as next steps, don't build)

- ~~An MCP gateway as a separate service~~ (the user asked for one after the plan: ADR 017, built
  in Phase 8).
- A2A and partner agents; multi-agent orchestration.
- MCP Apps, voice, the WebSocket channel.
- Real IdP, DPoP, device attestation, FAPI 2.0 compliance.
- Durable execution engine (Temporal); production deployment, autoscaling, WAF.
