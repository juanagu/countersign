from pydantic_ai import RunContext
from pydantic_ai.toolsets import FunctionToolset

from app.chat.deps import BotDeps
from app.skills.registry import SkillRegistry


def skills_toolset(registry: SkillRegistry) -> FunctionToolset[BotDeps]:
    toolset: FunctionToolset[BotDeps] = FunctionToolset()

    @toolset.tool
    def load_skill(ctx: RunContext[BotDeps], name: str) -> str:
        """Load a skill's instructions and unlock its tools for the rest of this turn."""
        skill = registry.get(name)
        if skill is None:
            return f"Unknown skill {name!r}. Available: {', '.join(registry.names())}."
        ctx.deps.loaded_skills.add(skill.name)
        return skill.instructions

    return toolset
