-include .env
POSTGRES_HOST_PORT ?= 5432
# Repository tests run against the seeded compose Postgres when it is up, and skip otherwise.
export TEST_DATABASE_URL ?= postgres://bank:bank@localhost:$(POSTGRES_HOST_PORT)/bank

COMPOSE := docker compose -f infra/docker-compose.yml --env-file .env
BOT := uv run --directory services/bot

.PHONY: help install set-key up down logs contracts contracts-check seed ingest test eval eval-backup failover-demo redteam pii-scan metrics lint format

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-16s %s\n", $$1, $$2}'

install: ## Install Node and Python dependencies
	pnpm install --frozen-lockfile
	uv sync --project services/bot --frozen

.env:
	cp .env.example .env

set-key: ## Prompt for ANTHROPIC_API_KEY (hidden) and save it to .env
	@sh scripts/set-anthropic-key.sh

up: .env ## Build and start infra + all services, waiting until healthy
	$(COMPOSE) up -d --build --wait

down: ## Stop and remove containers
	$(COMPOSE) down

logs: ## Tail container logs
	$(COMPOSE) logs -f

contracts: ## Regenerate TS + Python types from JSON Schema
	pnpm contracts

contracts-check: contracts ## Fail if generated contracts are out of date
	git diff --exit-code -- packages/contracts/src/generated services/bot/app/contracts/generated
	@test -z "$$(git ls-files --others --exclude-standard packages/contracts/src/generated services/bot/app/contracts/generated)" \
		|| (echo "untracked generated contracts; commit them" && exit 1)

seed: ## Load mock bank data (drops and recreates the bank schema)
	cat data/seed/*.sql | $(COMPOSE) exec -T postgres psql -q -v ON_ERROR_STOP=1 -U bank -d bank

ingest: ## Chunk + embed data/kb into pgvector (first run downloads the embedding model)
	$(COMPOSE) exec -T bot /opt/venv/bin/python -m app.knowledge.ingest

test: ## All unit/integration tests
	pnpm test
	$(BOT) pytest

BOT_ENV := cd services/bot && set -a && . ../../.env && set +a &&

eval: seed ## Live golden scenarios, KB grounding, tool selection, LLM judge and red team, gated by evals/thresholds.yaml (needs ANTHROPIC_API_KEY, make up, make ingest)
	$(BOT_ENV) uv run python -m evals.run $(EVAL_ARGS)

# ADR 018. The fault reaches the container through the bot's `LLM_FAULT_INJECTION` in infra/docker-compose.yml.
FAULT ?= orchestrator:overloaded
BACKUP_FAULT := primary:overloaded
RESTART_BOT = $(COMPOSE) up -d --no-deps --force-recreate --wait bot

failover-demo: ## Restart the bot with a model fault (FAULT=orchestrator:stall, guard:529...); FAULT= turns it off
	LLM_FAULT_INJECTION='$(FAULT)' $(RESTART_BOT)

eval-backup: seed ## Live eval suite with both roles' primaries forced to fail, so the backups answer; restores the bot
	LLM_FAULT_INJECTION='$(BACKUP_FAULT)' $(RESTART_BOT)
	( $(BOT_ENV) uv run python -m evals.run --backup $(EVAL_ARGS) ); status=$$?; \
		LLM_FAULT_INJECTION= $(RESTART_BOT); exit $$status

redteam: ## Red-team prompts through the live BFF, scored blocked/safely handled (needs make up)
	$(BOT_ENV) uv run python -m evals.redteam $(REDTEAM_ARGS)

pii-scan: ## Fail if synthetic PII appears in container logs or Phoenix traces (run after make eval)
	$(BOT_ENV) uv run python -m evals.pii_scan

metrics: ## Latency (time to first token / first surface), tokens per run and guardrail blocks, from Phoenix and bot logs
	$(BOT_ENV) uv run python -m evals.metrics $(METRICS_ARGS)

lint: ## Lint, format check and typecheck, TS and Python
	pnpm lint
	pnpm typecheck
	$(BOT) ruff check .
	$(BOT) ruff format --check .
	$(BOT) mypy

format: ## Apply formatters
	pnpm format
	$(BOT) ruff format .
	$(BOT) ruff check --fix .
