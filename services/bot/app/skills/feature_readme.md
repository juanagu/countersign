# skills

Domain behaviour as markdown files (`services/bot/skills/*.md`): YAML frontmatter (`name`, `description`,
`tools` allow-list, `max_tier`, optional `scopes`) plus instructions. `scopes` lists the gateway scopes the
skill's MCP tools need to be listed. A skill that lists an approval-only scope (`transfers:execute`) fails validation.

## Exposed interface

- `SkillRegistry.from_dir`, `.get`, `.index()` (the list the orchestrator sees), `.scopes_by_skill()` (`{name:
  scopes}`, which `main.py` hands to `banking_toolset`), `Skill`.
- `skills_toolset(registry)`: the `load_skill(name)` tool. It returns the skill's instructions and adds it
  to `BotDeps.loaded_skills` for the rest of the run.

## Data flow

Index in the instructions → model calls `load_skill` → `PolicyToolset` starts showing that skill's tools.
Loaded skills last the whole thread: `routes.py` rebuilds `loaded_skills` from every past `load_skill` in the
history (an approval resume needs it), so a later turn keeps the wider token and tools (backlog F59).
