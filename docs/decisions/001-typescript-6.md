# 001 — Pin TypeScript to 6.0

## Context
TypeScript 7.0 (the native compiler) is the current release, but `typescript-eslint` 8.72
declares `typescript >=4.8.4 <6.1.0` as its peer range; it needs the compiler's JS API.

## Decision
Pin `typescript` to `~6.0.3` across the workspace.

## Consequences
Lint with type information keeps working. Revisit when `typescript-eslint` supports 7.x.
