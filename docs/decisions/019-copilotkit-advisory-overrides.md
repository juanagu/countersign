# 019 — pnpm overrides for CopilotKit's high advisories; zod 3's advisory accepted

**Status:** accepted (2026-11-15).

## Context
Before the repo goes public, the weekly CI job runs `pnpm audit --prod` and fails on any high or critical
advisory that has a patched version. On 2026-11-15 there were 8 highs, all in CopilotKit 1.87's transitive tree
(backlog F55):

- undici 5.29.0 (five advisories) and @fastify/busboy 2.1.1, under `@ai-sdk/google-vertex` in the BFF's runtime.
  We build no Vertex provider, so none of it is reachable.
- graphql-scalars 1.26.0 (PhoneNumber ReDoS), under the runtime's GraphQL endpoint. The BFF serves the v2
  endpoint and defines no PhoneNumber field.
- zod 3.25.76 (GHSA-mrhx-c7xc-m3w5, memory exhaustion validating oversized constrained collections). This is the
  zod that CopilotKit, AG-UI and `@a2ui/web_core` all use, in the web client and in the BFF's `@ag-ui/client`.
  The only fix is zod ≥ 4.6.6.

Tried: overriding zod to ^4.6.7. `@a2ui/web_core` 0.15.0 clones zod 3 internals (`_def`) when it loads, so the
A2UI renderer throws on import (`Cannot read properties of undefined (reading 'call')`) and six web test files
fail. 0.15.0 is the latest web_core, still on zod `^3.25.76`, and CopilotKit 1.88 pins it. No patched zod 3
exists.

## Decision
- `overrides` in `pnpm-workspace.yaml`: `undici@<6.29.1` → ^6.29.1 (that also lifts busboy to a patched 3.x) and
  `graphql-scalars@<2.0.1` → ^2.0.1.
- zod stays on 3.25.76, and `auditConfig.ignoreGhsas` lists GHSA-mrhx-c7xc-m3w5. The schemas this zod runs are
  CopilotKit's and AG-UI's own static ones. Its input is the BFF's event stream and A2UI the bot already
  validated against the catalog (security rule 5). The worst case is one user's own tab running out of memory.

Verified: lint, unit and integration tests; the BFF container rebuilt with the overrides; and the Playwright smoke,
scenario (A2UI chart, transfer with step-up, cancel), resume and welcome specs on both projects against the live
stack.

## Consequences
- The weekly audit is green with a low (katex) and a moderate (`@hono/node-server`) left; both still sit in F55.
- Exit: when `@a2ui/web_core` moves to zod 4 (or CopilotKit drops it), remove the ignore entry, then remove each
  override once `pnpm why` shows CopilotKit pulling a patched version on its own.
- An ignored GHSA is invisible to the audit. A new zod advisory has a different id, so it still fails the run.
