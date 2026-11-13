# policy

The single gate in front of every domain tool (security rules 2 and 6).

## Exposed interface

- `ToolPolicy.visible(tool, tier, loaded)` and `.check_call(tool, tier, args, loaded) -> Decision`.
- `PolicyToolset(wrapped, policy, caps)`: hides tools no loaded skill grants, re-checks each call, wraps results
  as `{"untrusted_data": ..., "note": ...}`, and answers a denial with `{"error": "policy_denied"}`.
- `FrequencyCaps`: per-conversation (user + AG-UI `threadId`) sliding-window caps, 5 T2 and 3 T3 calls per
  10 minutes, in memory. `THIRD_PARTY_TEXT_TOOLS`: `list_transactions`, `search_knowledge`.
- `RiskTier`, `RISK_TIER_META_KEY` (`bank/riskTier` in the MCP tool `_meta`).

## Rules

A tool is callable only if it declares a tier, a loaded skill lists it and the tier ≤ the skill's
`max_tier`. Above T0 a call waits for the run's input verdict (`BotDeps.guard`) and is denied if the input was
blocked. A T2/T3 call in a conversation holding third-party text is re-evaluated by the guardrails' write-intent
check (an approved T3 resume is not). Writes count against the caps when they execute. Each domain-tool result
is recorded as grounding evidence for the output guard. Argument bounds: at most 50
transactions per call (an integer limit), periods ≤ 400 days, transfers > 0 and ≤ ARS 2,000,000 / USD 10,000.
The bounds fail closed: a period without `to` counts up to today, a date that isn't a `YYYY-MM-DD` string is
denied, and `spending_summary` needs a start date.

## Approval (T3)

T3 calls are `needs_approval`: without approval `PolicyToolset` raises `ApprovalRequired` (metadata
`draft_id`), which ends the run as an AG-UI interrupt. `step_up_token` is hidden from the model's schema and
arrives only in the approved arguments from the app (ADR 013).
