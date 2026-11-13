# Conversational Banking Assistant — POC

A proof of concept for a banking-grade chatbot: streamed answers over SSE, generative UI,
RAG with citations, an agent calling domain tools over MCP, guardrails and a human-approved
money-movement flow. All data is synthetic. The brief is [`AGENTS.md`](AGENTS.md) (`CLAUDE.md` imports it); the build
plan is [`docs/PLAN.md`](docs/PLAN.md); decisions are in [`docs/decisions/`](docs/decisions/). To run the
five demo scenarios in the browser, follow [`docs/DEMO.md`](docs/DEMO.md).

## Prerequisites

- Node 22+ and pnpm 12 (`brew install pnpm`)
- uv 0.13+ (`brew install uv`); it installs Python 3.12 for the bot
- Docker with Compose v2

## Setup

```sh
make install        # pnpm install + uv sync; also installs the pre-push hook
make set-key        # paste your Anthropic API key (hidden); saved to .env
make up             # copies .env.example to .env on first run, builds, waits until healthy
```

Every service answers `GET /health`:

| Service | URL |
| --- | --- |
| web | http://localhost:5173 |
| bff | http://localhost:3000 |
| bot | http://localhost:8000 |
| mcp-accounts | http://localhost:8101 |
| mcp-payments | http://localhost:8102 |
| Phoenix (traces) | http://localhost:6006 |

If another local stack already uses a port, set the matching `*_HOST_PORT` in `.env`
(for example `POSTGRES_HOST_PORT=5433`). Only the host side changes; containers keep the
standard ports. All ports bind to 127.0.0.1.

## Commands

Run `make help` for the full list.

```
make up / make down   # start / stop the stack
make contracts        # regenerate TS + Python types from packages/contracts/schemas
make lint             # eslint, prettier, tsc, ruff, mypy
make test             # vitest + pytest
make seed / ingest    # load mock bank data / embed the knowledge base
make eval             # live evals: golden scenarios, KB grounding, tool selection, LLM judge, red team; gated by thresholds
make metrics          # p50/p95 time to first token and first UI surface, tokens per run, guardrail blocks
make pii-scan         # check logs and traces for unredacted synthetic PII
```

## Layout

```
apps/web               React + Vite (CopilotKit chat from Phase 1)
apps/bff               Hono BFF + mock IdP
services/bot           FastAPI + Pydantic AI (uv project)
services/mcp-accounts  MCP server, account tools
services/mcp-payments  MCP server, payment tools
packages/contracts     JSON Schema → generated TS (src/generated) and Pydantic (services/bot/app/contracts/generated)
infra/                 docker-compose: Postgres + pgvector, Redis, Phoenix, all services
data/kb, data/seed     synthetic knowledge base and bank data
```

Generated contract code is committed; the pre-push hook runs `make contracts-check` to catch drift.

There is no CI for this POC ([ADR 004](docs/decisions/004-local-checks-instead-of-ci.md)): the
pre-push hook runs `make contracts-check lint test`, and every phase is verified locally.
