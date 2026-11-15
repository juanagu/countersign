# subagents

Domain subagents running in the bot's process (ADR 021). A subagent is a skill that runs as its own Pydantic AI
agent, on its own model, called by the orchestrator through one delegate tool, with its own tool policy and
gateway token. Subagents stop at T2: the orchestrator owns every T3 tool.

## Exposed interface

- `SubagentRegistry.from_dir(directory, skills=...)`: parses `services/bot/subagents/*.md`, which have a skill's
  frontmatter and validators (`parse_skill`). A spec above T2 (`SUBAGENT_MAX_TIER`), one named like a skill, or
  a duplicate name fails to load; an approval-only scope fails like it does for a skill. `.get`, `.specs()`,
  `.names()`, `.scopes_by_skill()` (`{name: scopes}`, for that subagent's own banking toolset) and `.index()`
  (the agent list for the orchestrator's instructions, or `None`).
- `delegate_tool_name(name)`: `ask_<name>`, the orchestrator's tool for that subagent.
- `build_subagent(spec, model, domain_tools, caps, clock)` (`build.py`): an `Agent[BotDeps, str]` named after the spec,
  with `genui_toolset()` and `PolicyToolset(TemplateToolset(banking))` over a registry holding only its own skill. Its
  output has no `DeferredToolRequests`, so a deferred call fails its run with `UserError`.
- `delegate_toolset([Subagent(spec, agent)])` (`delegate.py`): one `ask_<name>(request)` tool per subagent, plus
  `subagent_prompt`, `forwarded_events`, `last_prepared_draft`, `DRAFT_SKILL` (`transfers`) and `DRAFT_NEXT_STEP`.
- Shipped: `services/bot/subagents/payments.md` (T2: beneficiaries, accounts, `prepare_transfer`), on
  `PAYMENTS_AGENT_MODEL` (empty = the orchestrator's models). `main.build_agent_tree` wires it.

## Data flow

`ask_payments(request)` awaits the input verdict (blocked: no subagent run), then runs the subagent with
`dataclasses.replace(deps, loaded_skills={name}, unavailable_servers=set())`, so identity, token, thread and the same
`RunGuard` carry over, and `usage=ctx.usage`. The prompt holds the customer's last three redacted messages and the
request, labelled as the orchestrator's; there is no history. The return is
`{"untrusted_data": {"agent", "status", "reply", "draft_id"}, "note"}`: `status` (`ok`, `unavailable`, `failed`) and
`draft_id` (from the last successful `prepare_transfer` result) are set by code. When `draft_id` is set, the delegate
also adds `transfers` to the orchestrator's `loaded_skills`, so its next step lists `execute_transfer` without a
`load_skill` call, puts the fixed `DRAFT_NEXT_STEP` (call `execute_transfer` with exactly that `draft_id`) beside the
wrapper as `next_step`, and records the load as a `skill_load_record` metadata item, which a resume's replay reads
(`skills_loaded_in`). Without a draft it loads nothing. Its `metadata` carries the
`bank-template` events of template tools and the `a2ui-surface` events of `render_ui` (the output guard checks them
like the orchestrator's), plus one evidence record of the subagent's tool results for later turns. The call's events
are withheld from the client (`is_server_only`). Each run logs one `subagent.run` line: agent, status, duration,
requests, tool names, trace id, never text or arguments.
