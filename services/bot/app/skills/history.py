from collections.abc import Collection, Iterable, Iterator, Mapping

from pydantic_ai.messages import ModelMessage, ToolCallPart, ToolReturnPart

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


def _skills_recorded_on(part: ToolReturnPart, delegates: Collection[str]) -> Iterator[str]:
    """Read only on a delegate tool's return: any other tool's metadata could be filled by a backend."""
    metadata = part.metadata if part.tool_name in delegates else None
    for item in metadata if isinstance(metadata, list) else ():
        if isinstance(item, Mapping) and item.get("kind") == SKILL_LOAD_RECORD and isinstance(item.get("skill"), str):
            yield item["skill"]


def skills_loaded_in(messages: Iterable[ModelMessage], *, delegates: Collection[str] = frozenset()) -> set[str]:
    """Skills a previous turn loaded: the model's `load_skill` calls in the stored history, and the loads code
    recorded on a delegate tool's return (`skill_load_record`, e.g. `transfers` when payments returns a draft).

    A resumed run (tool approval) or a follow-up question must see the tools of the skill it was using.
    The history is the bot's own, so a client cannot claim a skill was loaded. Pre-loading only reveals
    instructions and tool names; every call is still bound by the user's tokens and the tool policy, and money
    movement still needs approval plus step-up.
    """
    loaded: set[str] = set()
    for message in messages:
        for part in message.parts:
            if isinstance(part, ToolCallPart) and part.tool_name == LOAD_SKILL and (name := _skill_named_by(part)):
                loaded.add(name)
            elif isinstance(part, ToolReturnPart):
                loaded.update(_skills_recorded_on(part, delegates))
    return loaded


def replayed_skills(
    messages: Iterable[ModelMessage], skills: SkillRegistry, *, delegates: Collection[str] = frozenset()
) -> set[str]:
    """The skills a run starts with: those the history loaded that `skills` still has, a renamed one by its new
    name."""
    loaded = skills_loaded_in(messages, delegates=delegates)
    current = {name if skills.get(name) else RENAMED_SKILLS.get(name, name) for name in loaded}
    return {name for name in current if skills.get(name)}
