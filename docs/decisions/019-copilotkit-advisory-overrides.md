# 019 — pnpm overrides for CopilotKit's high advisories; zod 3's advisory accepted

**Status:** accepted (2026-11-15).

## Context
The weekly CI job runs `pnpm audit --prod` and fails on any high or critical advisory that has a patched
version. On 2026-11-15 there were 8 highs, all in CopilotKit 1.87's transitive tree
(backlog F55):

- undici 5.29.0 (five advisories) and @fastify/busboy 2.1.1, under `@ai-sdk/google-vertex` in the BFF's runtime.
  We build no Vertex provider, so none of it is reachable.
- graphql-scalars 1.26.0 (PhoneNumber ReDoS), under the runtime's v1 GraphQL endpoint. The BFF imports only
  `@copilotkit/runtime/v2`, whose code never loads type-graphql or graphql-scalars.
- zod 3.25.76 (GHSA-mrhx-c7xc-m3w5, memory exhaustion validating oversized constrained collections). This is the
  zod that CopilotKit, AG-UI and `@a2ui/web_core` all use, in the web client and in the BFF's `@ag-ui/client`.
  The only fix is zod ≥ 4.6.6.

Tried: overriding zod to ^4.6.7. `@a2ui/web_core` 0.15.0 clones zod 3 internals (`_def`) when it loads, so the
A2UI renderer throws on import (`Cannot read properties of undefined (reading 'call')`) and six web test files
fail. 0.15.0 is the latest web_core, still on zod `^3.25.76`, and CopilotKit 1.88 pins it. No patched zod 3
exists.

## Decision
- `overrides` in `pnpm-workspace.yaml`: `undici@<6.29.1` → ^6.29.1 (undici 6 has no busboy dependency, so
  busboy 2.1.1 leaves the tree) and `graphql-scalars@<2.0.1` → ^2.0.1, a major bump outside type-graphql's
  peer range that is safe only because the v2 runtime never loads it.
- zod 3 stays on 3.25.76, and `auditConfig.ignoreGhsas` lists GHSA-mrhx-c7xc-m3w5. That zod runs on the server too: the v2 runtime parses each run body with
  `RunAgentInputSchema` from `@ag-ui/core` on zod 3, so a signed-in user could exhaust the BFF's memory with an
  oversized `messages` or `tools` array. Without a limit, a 3 MB body crashed the test worker. So the copilot
  route takes at most `MAX_RUN_BODY_BYTES` (1 MiB) and answers 413 over it, before the runtime parses
  anything. In the browser, this zod parses the BFF's event stream and A2UI the bot already validated (security
  rule 5).

Verified: lint, unit and integration tests (the 413 test included); the BFF container rebuilt with the overrides
and the limit; and the Playwright smoke, scenario (A2UI chart, transfer with step-up, cancel), resume and welcome
specs on both projects against the live stack.

## Consequences
- The weekly audit is green with a low (katex) and a moderate (`@hono/node-server`) left; both sit in F57.
- Exit: when `@a2ui/web_core` moves to zod 4 (or CopilotKit drops it), remove the ignore entry, then remove each
  override once `pnpm why` shows CopilotKit pulling a patched version on its own.
- The ignore can't be scoped to a version, so it would also hide a vulnerable zod 4 copy. Today every zod 4 is
  4.6.7. An override to floor zod 4 was tried and dropped: pnpm rewrote every `^3.25 || ^4` zod peer range to
  `^4.6.7`, which invites the next unfrozen install to move A2UI onto zod 4.
- An ignored GHSA is invisible to the audit. A new zod advisory has a different id, so it still fails the run.
- A conversation whose run body grows past 1 MiB gets a 413. Raise the constant if real threads reach it.
