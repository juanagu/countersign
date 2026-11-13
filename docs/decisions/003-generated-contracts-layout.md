# 003 — Generated contracts are committed, in two fixed locations

## Context
`packages/contracts/schemas/*.json` is the source of truth. TS and Python consumers need
the generated types without running the generator first (Docker builds, editors).

## Decision
- `make contracts` writes TS to `packages/contracts/src/generated/` (exported as
  `@poc/contracts`) and Pydantic v2 models to `services/bot/app/contracts/generated/`.
- Generated files are committed. CI runs `make contracts-check`, which regenerates and
  fails on any diff.

## Consequences
Schema edits show up with their generated diff in the same PR. Generated folders are
excluded from lint and formatting.
