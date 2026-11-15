# 004 — No CI for the POC; checks run locally

**Status:** amended on 2026-11-14. The repository is going public, and public repositories get GitHub Actions minutes
for free, so the budget reason below no longer holds and CI now exists (see Amendment).

## Context
GitHub Actions minutes are budgeted across all repos, and this POC has a single developer.

## Decision
No `.github/workflows`. The committed pre-push hook runs `make contracts-check lint test`, and each
phase's acceptance checks (including `make up`) are run locally before review.

## Consequences
Nothing re-checks a push made with `--no-verify` or from a machine without `make install`. No weekly
dependency audit runs on its own; run the dependency-audit skill by hand before sharing the POC.
If the POC graduates, restore a CI fast tier from the agent-config template.

## Amendment (2026-11-14)
`.github/workflows/ci.yml` runs the fast tier on every PR push and every push to `main`: `make contracts-check`,
`make lint` and `make test`, with a seeded pgvector service so the Postgres-backed tests run (the retrieval tests
still skip: they need `make ingest`). A weekly run does `pnpm audit --prod --audit-level=high` and opens an issue
on a fixable finding. The Playwright specs and `make eval` stay local: they need the live stack and a paid model,
and CI holds no secrets. The pre-push hook stays, as the same checks before the push.
