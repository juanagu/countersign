# Countersign — conversational banking assistant POC

This repo is a proof of concept for a banking-grade chatbot. It proves one reference
architecture end to end: streamed answers over SSE, generative UI (A2UI + server
templates), RAG with citations, an agent that calls domain tools over MCP, guardrails,
and a human-approved money-movement flow. The build plan lives in `docs/PLAN.md`.
Work through it phase by phase.

## How to work in this repo

- **Follow `docs/PLAN.md` one phase at a time.** At the end of each phase, run the
  phase's acceptance checks, summarise what was built and what deviated, and stop for
  review. Do not start the next phase until told to.
- **Verify library APIs against current docs before writing code.** CopilotKit v2,
  A2UI v0.9, AG-UI, Pydantic AI and the MCP SDKs move fast, and names in this file may be
  stale. Use the Context7 MCP server or the official docs. If an API named here
  doesn't exist or has changed, use the current equivalent and note it in the
  phase summary.
- **Record decisions.** Any choice not settled here (library, wire format, workaround)
  gets a short ADR in `docs/decisions/NNN-title.md`: context, decision, consequences.
- **Track work in `docs/backlog.md`**, not GitHub Issues or a Project board: one row per phase plus
  follow-ups. Update a row when its status changes.
- **Stay in scope.** Don't add services, frameworks or features the plan doesn't ask
  for. If something seems missing, propose it in the phase summary instead.
- **Tests are part of done.** Every phase adds tests for what it built (pytest for
  Python, vitest for TypeScript). Security rules below each need at least one
  negative test.
- **No real secrets or real customer data.** Everything is synthetic. Keys come from
  `.env` (never committed); keep `.env.example` current.

## Architecture

Flows, token chain and ADR index: `docs/architecture.md`.

```
React web (CopilotKit v2) ──HTTPS / SSE──▶ BFF (Node, Hono)
                                            ├─ CopilotKit runtime → HttpAgent → bot
                                            └─ mock IdP: login, token exchange, step-up, JWKS
                                                         │ AG-UI over SSE
                                                         ▼
                                Bot (Python, FastAPI + Pydantic AI)
                                ├─ orchestrator agent + domain skills + in-process subagents (payments)
                                ├─ guardrails (input / tool policy / output)
                                ├─ RAG (pgvector hybrid search)
                                └─ MCP client ──streamable HTTP, aud=mcp-gateway JWT──▶
                                         mcp-gateway (Node): catalog, rate limits, breaker, audit
                                              │ streamable HTTP, aud per backend, act [mcp-gateway, bot]
                                              ▼
                                         mcp-accounts (Node)   mcp-payments (Node)
                                                    └──── Postgres (mock bank data) ────┘
Infra: Postgres + pgvector, Redis (event log for resume), Phoenix (OpenTelemetry traces)
```

One orchestrator agent, plus **domain subagents** for complex domains (ADR 021). Thin domain
behaviour comes from **skills** (markdown instruction files plus a tool allow-list) that the
orchestrator loads on demand. A subagent is a skill that runs as its own Pydantic AI agent in the
bot's process, on its own model, called by the orchestrator as a tool, with its own tool policy
and gateway token. Subagents stop at T2: the orchestrator owns every T3 tool. They share one
process and one IdP client, so their separate tokens guard against mistakes, not against a
compromised process. A domain that needs real isolation becomes a separate agent service, with
its own process, IdP client and gateway audience, under its own ADR. No A2A in this POC.

## Stack

| Part | Path | Tech |
| --- | --- | --- |
| Web | `apps/web` | React + Vite + TypeScript, CopilotKit v2 (`@copilotkit/react-core/v2`), A2UI renderer via CopilotKit |
| BFF | `apps/bff` | Node 22 + TypeScript + Hono, CopilotKit runtime v2 with `HttpAgent` → bot, `jose` for JWT |
| Bot | `services/bot` | Python 3.12, uv, FastAPI, `pydantic-ai-slim[ag-ui,anthropic,mcp]`, served with `AGUIAdapter` |
| MCP servers | `services/mcp-accounts`, `services/mcp-payments` | Node 22 + TypeScript, `@modelcontextprotocol/sdk`, streamable HTTP transport |
| MCP gateway | `services/mcp-gateway` | Node 22 + TypeScript + Hono, `@modelcontextprotocol/sdk` (ADR 017) |
| Contracts | `packages/contracts` | JSON Schema as source of truth → TS types (json-schema-to-typescript) and Pydantic models (datamodel-code-generator) |
| Data | `data/kb`, `data/seed` | Synthetic markdown knowledge base; SQL seed for mock accounts, transactions, beneficiaries |
| Infra | `infra/docker-compose.yml` | Postgres 16 + pgvector, Redis 7, Arize Phoenix |
| Evals | `services/bot/evals` | pydantic-evals + pytest |

Tooling: pnpm workspaces for Node packages, uv for Python, a root `Makefile`.

**Models** (env vars, never hard-coded):
- `BOT_MODEL=anthropic:claude-sonnet-5-5`: orchestrator.
- `GUARD_MODEL=anthropic:claude-haiku-5-5`: classifiers and judges.
- `PAYMENTS_AGENT_MODEL` (empty = the orchestrator's chain): the payments subagent.

**Embeddings:** Anthropic has no embeddings API. Default to a local multilingual model via
`fastembed` (pick a multilingual model it supports, such as an E5 variant). Keep the
embedder behind an interface so Voyage AI can be swapped in later.

**Language:** the bot answers in the user's language and defaults to Spanish.
Synthetic data and the knowledge base are in Spanish.

**Ports:** web 5173, bff 3000, bot 8000, mcp-gateway 8100, mcp-accounts 8101, mcp-payments 8102,
postgres 5432, redis 6379, phoenix 6006.

## Security rules (non-negotiable, each needs a negative test)

1. **The model never holds credentials.** The bot receives the user's access token
   (`aud=bot`) from the BFF and exchanges it at the mock IdP (`/token`, RFC 8693-shaped)
   for `aud=mcp-gateway` once per agent (the orchestrator and each subagent), each token
   scoped to the skills that agent has loaded, never their union; the gateway lists and
   serves only the tools its token's scopes allow, then exchanges again for each backend's
   audience, with only the scopes it needs. No hop forwards the token it received (no passthrough). Each
   MCP server, the gateway included, rejects any token whose `aud` isn't its own, and the
   backends require the actor chain `[mcp-gateway, bot]`.
2. **Risk tiers on every tool.** T0 public read, T1 personal read, T2 reversible write,
   T3 money movement. Tier is declared in tool metadata and enforced by the tool policy
   of the agent that calls the tool, not by the prompt. A subagent's tools stop at T2.
3. **T3 needs human approval plus step-up.** `execute_transfer` is approval-required
   (Pydantic AI deferred tool → AG-UI interrupt) and held only by the orchestrator; a subagent
   may prepare a transfer, never execute one. The user confirms on a server-template
   card. The mock IdP's `/auth/step-up` (PIN `123456`) issues a short-lived, single-use token
   whose `authorization_details` claim (RAR-shaped) contains the exact draft: `draft_id`,
   amount, currency, beneficiary id. `mcp-payments` executes only if signature, `aud`,
   `exp`, unused `jti` and `authorization_details` all match the stored draft. The access
   token's `transfers:execute` scope is requested only for the approved call, in a token
   that carries no other scope.
4. **Transactional UI is never model-generated.** Confirm and receipt cards are server
   templates. Their data comes from the MCP tool result through code, never from model
   text. The model only decides that a transfer is being prepared.
5. **A2UI is validated before it leaves the bot.** Every A2UI payload is validated
   against the catalog schema in `packages/contracts`. Invalid payloads are dropped and
   replaced by a text fallback. Login, PIN, password and card-number inputs do not exist
   in the catalog.
6. **Tool output is untrusted data.** Wrap tool results so the model sees them as data,
   and never let text inside a tool result (memos, merchant names) trigger a write tool
   without a fresh policy check. A subagent's answer reaches the orchestrator as untrusted
   data in the same way, and its text never grounds a figure.
7. **No PII in logs or traces.** Redact before logging; Phoenix spans carry redacted
   content only.
8. **User identity comes from the token, never from the request body or the model.**

## Conventions

- **Python:** ruff + mypy (strict on `services/bot/app`), pytest, async everywhere,
  Pydantic models for every boundary, structured logging.
- **TypeScript:** strict mode, eslint + prettier, vitest, zod for runtime validation at
  boundaries.
- **Contracts:** never hand-write a type that exists in `packages/contracts`. Edit the
  schema, then run `make contracts`.
- **Commits:** one logical change each, conventional commit messages, phase tag in the
  scope, e.g. `feat(p2): add mcp-payments prepare_transfer`.
- **Config:** 12-factor, env vars only, defaults in `.env.example`.
- **Observability:** every service exports OpenTelemetry to Phoenix. Propagate
  `traceparent` across bff → bot → MCP.

## Commands (keep this section current as they are created)

```
make install     # pnpm install + uv sync (+ pre-push hook)
make set-key     # prompt for ANTHROPIC_API_KEY (hidden), saved to .env
make up          # docker compose up infra + all services, waits until healthy
make down
make logs
make contracts   # regenerate TS + Python types from JSON Schema
make contracts-check  # fail if generated contracts are stale (pre-push)
make seed        # load mock bank data
make ingest      # chunk + embed data/kb into pgvector
make test        # all unit/integration tests
make eval        # re-seeds, then live golden scenarios, KB grounding, tool selection, LLM judge and red team;
                 # fails under services/bot/evals/thresholds.yaml (needs ANTHROPIC_API_KEY, make up, make ingest)
make redteam     # red-team prompts through the live BFF; fails under the redteam/controls thresholds
make metrics     # p50/p95 time to first token / first surface, tokens per run, guardrail blocks (Phoenix + logs)
make pii-scan    # fail if synthetic PII appears in container logs or Phoenix traces
make lint        # eslint, prettier, tsc, ruff, mypy
```
