# policy

The single gate in front of every domain tool (security rules 2 and 6).

## Exposed interface

- `ToolPolicy.visible(tool, tier, loaded)` and `.check_call(tool, tier, args, loaded, open_draft) -> Decision`.
- `drafts.open_draft(messages, delegates=)`, `prepared_draft_id(content)`, `PREPARE_TRANSFER`, `DRAFT_BOUND_TOOLS`
  (`execute_transfer`): the conversation's one open draft, which `execute_transfer` may name.
- `PolicyToolset(wrapped, policy, caps, delegates)`: hides tools no loaded skill grants, re-checks each call, wraps
  results as `{"untrusted_data": ..., "note": UNTRUSTED_NOTE}`, and answers a denial with `{"error": "policy_denied"}`.
  `UNTRUSTED_NOTE` is exposed so a delegate tool wraps a subagent's answer the same way.
- `FrequencyCaps`: per-conversation (user + AG-UI `threadId`) sliding-window caps, 5 T2 and 3 T3 calls per
  10 minutes, in memory; `.acquire_delegation(session, turn)` caps delegations at `DELEGATIONS_PER_TURN` (3) per
  orchestrator run.
- `DelegatePolicyToolset(wrapped, caps, names)` (`delegate_policy.py`): the gate in front of the delegate tools, which
  no skill grants. A call is denied (`policy_denied`, via `denied()`) when the tool declares no tier, when the input
  verdict blocked the message (above T0), or past the per-turn delegation cap; `names` are the delegate tool names. `THIRD_PARTY_TEXT_TOOLS`: `list_transactions`, `search_knowledge`.
- `RiskTier`, `RISK_TIER_META_KEY` (`bank/riskTier` in the MCP tool `_meta`).
- `tool_scopes`: `SCOPE_META_KEY` (`bank/scope`, needed to call), `read_scope`, `SCOPE_PATTERN` (`^[a-z]+:[a-z]+$`) and
  `APPROVAL_ONLY_SCOPES` (`transfers:execute`), which no skill may request. Used by `banking` and `skills`.

## Rules

A tool is callable only if it declares a tier, a loaded skill lists it and the tier ≤ the skill's
`max_tier`. Above T0 a call waits for the run's input verdict (`BotDeps.guard`) and is denied if the input was
blocked. A T2/T3 call in a conversation holding third-party text is re-evaluated by the guardrails' write-intent
check (an approved T3 resume is not). Writes count against the caps when they execute. Each domain-tool result
is recorded as grounding evidence for the output guard. Argument bounds: at most 50
transactions per call (an integer limit), periods ≤ 400 days, transfers > 0 and ≤ ARS 2,000,000 / USD 10,000.
The bounds fail closed: a period without `to` counts up to today on the bank's calendar (`BANK_TIMEZONE`, via `BankClock`), a date that isn't a `YYYY-MM-DD` string is
denied, and `spending_summary` needs a start date.

## Approval (T3)

`execute_transfer`'s `draft_id` must be a string naming the conversation's open draft: the latest draft a
`prepare_transfer` result created, in the run's messages (stored history included) or in a delegate tool's evidence
record when the payments subagent prepared it, that no `execute_transfer` result has decided yet: a receipt, the
customer's denial or cancel, the bank's answer about the draft (a failed result such as `draft_expired`), or a result
Pydantic AI synthesized for a cut-off call. A refusal before anything was sent decides nothing (`UNSENT_ERRORS`:
`policy_denied`, a cap or input verdict included, and the `service_unavailable` an approved call returns when its
token or session can't be set up; also a `retried` call), so the customer can ask again. A newer draft supersedes the older ones. An interrupt nobody
answered decides nothing, so the failed-resume recovery (ADR 013: ask again, approve again) still pauses on it. `PolicyToolset` reads it from
`ctx.messages`; otherwise the call is denied before any interrupt, on the first call and on the resume alike. Each agent has its own `PolicyToolset` over its own skills; a subagent's stops at
T2, and every agent shares the process's one `FrequencyCaps`.

T3 calls are `needs_approval`: without approval `PolicyToolset` raises `ApprovalRequired` (metadata
`draft_id`), which ends the run as an AG-UI interrupt. `step_up_token` is hidden from the model's schema and
arrives only in the approved arguments from the app (ADR 013).
