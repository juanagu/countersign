# skills

Domain behaviour as markdown files (`services/bot/skills/*.md`): YAML frontmatter (`name`, `description`,
`tools` allow-list, `max_tier`) plus instructions.

## Exposed interface

- `SkillRegistry.from_dir`, `.get`, `.index()` (the list the orchestrator sees), `Skill`.
- `skills_toolset(registry)`: the `load_skill(name)` tool. It returns the skill's instructions and adds it
  to `BotDeps.loaded_skills` for the rest of the run.

## Data flow

Index in the instructions → model calls `load_skill` → `PolicyToolset` starts showing that skill's tools.
Loaded skills last one run (one user turn); the model loads them again on the next turn.
