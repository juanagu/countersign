# 004 — No CI for the POC; checks run locally

## Context
GitHub Actions minutes are budgeted across all repos, and this POC has a single developer.

## Decision
No `.github/workflows`. The committed pre-push hook runs `make contracts-check lint test`, and each
phase's acceptance checks (including `make up`) are run locally before review.

## Consequences
Nothing re-checks a push made with `--no-verify` or from a machine without `make install`. No weekly
dependency audit runs on its own; run the dependency-audit skill by hand before sharing the POC.
If the POC graduates, restore a CI fast tier from the agent-config template.
