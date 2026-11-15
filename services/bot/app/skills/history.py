from collections.abc import Collection, Mapping, Sequence

from pydantic_ai.messages import ModelMessage, ToolCallPart

from app.guardrails.messages import records_on, tool_call_parts, tool_return_parts
from app.skills.registry import SkillRegistry

LOAD_SKILL = "load_skill"
SKILL_LOAD_RECORD = "bot-skill-load"
# Old skill names a stored history may hold, and the skill that grants their calls now: a customer paused at an
# approval the old skill granted must still find the call granted on the resume.
RENAMED_SKILLS: Mapping[str, str] = {"payments": "transfers"}


def skill_load_record(name: str) -> dict[str, str]:
    """A tool return's `metadata` item saying code loaded `name` in that run: plain JSON, so the conversation store
    keeps it and a later run's replay reads it like a `load_skill` call."""
    return {"kind": SKILL_LOAD_RECORD, "skill": name}


def _skill_named_by(call: ToolCallPart) -> str | None:
    try:
        name = call.args_as_dict().get("name")
    except ValueError:
        return None
    return name if isinstance(name, str) else None


def skills_loaded_in(messages: Sequence[ModelMessage], *, delegates: Collection[str] = frozenset()) -> set[str]:
    """Skills a previous turn loaded: the model's `load_skill` calls in the stored history, and the loads code
    recorded on a delegate tool's return (`skill_load_record`, e.g. `transfers` when payments returns a draft).

    A resumed run (tool approval) or a follow-up question must see the tools of the skill it was using.
    The history is the bot's own, so a client cannot claim a skill was loaded. Pre-loading only reveals
    instructions and tool names; every call is still bound by the user's tokens and the tool policy, and money
    movement still needs approval plus step-up.
    """
    called = {
        name for call in tool_call_parts(messages) if call.tool_name == LOAD_SKILL and (name := _skill_named_by(call))
    }
    recorded = {
        record["skill"]
        for part in tool_return_parts(messages)
        for record in records_on(part, delegates, SKILL_LOAD_RECORD)
        if isinstance(record.get("skill"), str)
    }
    return called | recorded


def replayed_skills(
    messages: Sequence[ModelMessage], skills: SkillRegistry, *, delegates: Collection[str] = frozenset()
) -> set[str]:
    """The skills a run starts with: those the history loaded that `skills` still has, a renamed one by its new
    name."""
    loaded = skills_loaded_in(messages, delegates=delegates)
    current = {name if skills.get(name) else RENAMED_SKILLS.get(name, name) for name in loaded}
    return {name for name in current if skills.get(name)}
