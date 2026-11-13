# policy

The single gate in front of every domain tool (security rules 2 and 6).

## Exposed interface

- `ToolPolicy.visible(tool, tier, loaded)` and `.check_call(tool, tier, args, loaded) -> Decision`.
- `PolicyToolset(wrapped, policy)`: hides tools no loaded skill grants, re-checks each call, wraps results
  as `{"untrusted_data": ..., "note": ...}`, and answers a denial with `{"error": "policy_denied"}`.
- `RiskTier`, `RISK_TIER_META_KEY` (`bank/riskTier` in the MCP tool `_meta`).

## Rules

A tool is callable only if it declares a tier, a loaded skill lists it and the tier ≤ the skill's
`max_tier`. T3 is always denied here until the approval flow (Phase 5). Argument bounds: at most 50
transactions per call (an integer limit), periods ≤ 400 days, transfers > 0 and ≤ ARS 2,000,000 / USD 10,000.
The bounds fail closed: a period without `to` counts up to today, a date that isn't a `YYYY-MM-DD` string is
denied, and `spending_summary` needs a start date.

## Approval (T3)

T3 calls are `needs_approval`: without approval `PolicyToolset` raises `ApprovalRequired` (metadata
`draft_id`), which ends the run as an AG-UI interrupt. `step_up_token` is hidden from the model's schema and
arrives only in the approved arguments from the app (ADR 013).
