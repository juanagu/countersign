COMPOSE := docker compose -f infra/docker-compose.yml --env-file .env
BOT := uv run --directory services/bot

.PHONY: help install set-key up down logs contracts contracts-check seed ingest test eval lint format

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

seed: ## Load mock bank data (Phase 2)
	@echo "seed: not implemented until Phase 2" && exit 1

ingest: ## Chunk + embed data/kb into pgvector (Phase 3)
	@echo "ingest: not implemented until Phase 3" && exit 1

test: ## All unit/integration tests
	pnpm test
	$(BOT) pytest

eval: ## pydantic-evals suite (Phase 8, needs ANTHROPIC_API_KEY)
	@echo "eval: not implemented until Phase 8" && exit 1

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
