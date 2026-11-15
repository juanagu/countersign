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

## Data flow

Not wired yet: the registry is parsed and validated, and nothing builds an agent from it.
