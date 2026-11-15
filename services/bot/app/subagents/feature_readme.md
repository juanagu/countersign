# subagents

Domain subagents running in the bot's process (ADR 021). A subagent is a skill that runs as its own Pydantic AI
agent, on its own model, called by the orchestrator through one delegate tool, with its own tool policy and
gateway token. Subagents stop at T2: the orchestrator owns every T3 tool.

## Exposed interface

- `SubagentRegistry.from_dir(directory, skills=...)`: parses `services/bot/subagents/*.md` into `SubagentSpec`s
  (`parse_subagent`): a skill's frontmatter and validators plus an optional `hands_off: {tool, skill}` (`HandOff`).
  A spec above T2 (`SUBAGENT_MAX_TIER`), one named like a skill, or a duplicate name fails to load; an approval-only
  scope fails like it does for a skill. A `hands_off` fails to load unless its `tool` is one of the spec's tools and
  its `skill` is a root skill at T3 that grants a draft-bound tool (`DRAFT_BOUND_TOOLS`). `.get`, `.specs()`,
  `.names()`, `.delegate_tools()` (the orchestrator's delegate tool names, which `main.create_app` hands to the chat
  and conversations routers), `.scopes_by_skill()` (`{name: scopes}`, for that subagent's own banking toolset) and
  `.index()` (the agent list for the orchestrator's instructions, or `None`).
- `delegate_tool_name(name)` and `DELEGATE_PREFIX`: `ask_<name>`, the orchestrator's tool for that subagent. Only
  naming and the evals use the prefix; the guardrails and the replay get the registry's names.
- `build_subagent(spec, model, domain_tools, caps, clock)` (`build.py`): an `Agent[BotDeps, str]` named after the spec,
  with `genui_toolset()` and `PolicyToolset(TemplateToolset(banking))` over a registry holding only its own skill. Its
  output has no `DeferredToolRequests`, so a deferred call fails its run with `UserError`.
- `delegate_toolset([Subagent(spec, agent)], caps=)` (`delegate.py`): one `ask_<name>(request)` tool per subagent,
  declaring the spec's `max_tier` (its ceiling, T2 for payments) under `bank/riskTier` in its metadata, behind
  `policy.DelegatePolicyToolset` with the conversation's `caps`. Plus `subagent_prompt`, `previous_reply`,
  `forwarded_events`, `last_prepared_draft` and `draft_next_step(skill)` (the code-written `DRAFT_NEXT_STEP`).
- `delegation_status` and `DelegationStatus` (`progress.py`): one status call spanning the subagent's run.
- Shipped: `services/bot/subagents/payments.md` (T2: beneficiaries, accounts, `prepare_transfer`; hands off
  `prepare_transfer` drafts to `transfers`), on `PAYMENTS_AGENT_MODEL` (empty = the orchestrator's models; its chain
  shares the breakers, and `LLM_FAULT_INJECTION`'s `primary:` and `all:` targets reach it). `main.build_agent_tree` wires it.

## Data flow

`DelegatePolicyToolset` refuses an `ask_<name>` call with `{"error": "policy_denied"}` before any subagent runs when
the tool declares no tier, when the input verdict blocked the message, or past `DELEGATIONS_PER_TURN` (3) delegations
in one orchestrator run (`FrequencyCaps.acquire_delegation`). Otherwise `ask_payments(request)` runs the subagent with
`dataclasses.replace(deps, loaded_skills={name}, unavailable_servers=set())`, so identity, token, thread and the same
`RunGuard` carry over, and `usage=ctx.usage`. The prompt holds the subagent's own previous reply in the thread (the
last `ask_<name>` return's `reply`, read by code, so "la segunda" resolves its own question), the customer's last three
redacted messages and the request, labelled as the orchestrator's, each escaped so no text can close its tag. There is
no other history. The return is
`{"untrusted_data": {"agent", "status", "reply", "draft_id"}, "note"}`: `status` (`ok`, `unavailable`, `failed`) and
`draft_id` (from the last successful result of the spec's `hands_off.tool`) are set by code. When `draft_id` is set,
the delegate also adds `hands_off.skill` (`transfers`) to the orchestrator's `loaded_skills`, so its next step lists
`execute_transfer` without a `load_skill` call, puts the code-written `next_step` (call `execute_transfer` with
exactly that `draft_id`) beside the wrapper, and records the load as a `skill_load_record` metadata item, which a
resume's replay reads (`skills_loaded_in`, only on a delegate tool's return). Without a draft, or a spec without
`hands_off`, it loads nothing. Its `metadata` carries the `bank-template` events of template tools and the
`a2ui-surface` events of `render_ui` (the output guard checks them like the orchestrator's); of the hand-off tool's
results only the bound draft's card is forwarded, so a run that prepared twice shows one card. It also carries one
evidence record of the subagent's tool results for later turns. The call's own
events are withheld from the client (`is_server_only` with the registry's delegate names). The subagent runs
unstreamed inside one status call (`delegation_status`): `TOOL_CALL_START` named `ask_<name>` under a fresh id
registered in `RunGuard.status_calls`, so the output guard lets it out, then, always, `TOOL_CALL_END` and an empty
`TOOL_CALL_RESULT`, so the web's progress label shows for the whole delegation. None of the subagent's own tool calls,
arguments or results leave. Each run logs one `subagent.run` line: agent, status, duration,
requests, tool names, trace id, never text or arguments.
