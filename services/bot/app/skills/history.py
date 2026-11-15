from collections.abc import Iterable, Iterator, Mapping

from pydantic_ai.messages import ModelMessage, ToolCallPart, ToolReturnPart

LOAD_SKILL = "load_skill"
SKILL_LOAD_RECORD = "bot-skill-load"


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


def _skills_recorded_on(part: ToolReturnPart) -> Iterator[str]:
    for item in part.metadata if isinstance(part.metadata, list) else ():
        if isinstance(item, Mapping) and item.get("kind") == SKILL_LOAD_RECORD and isinstance(item.get("skill"), str):
            yield item["skill"]


def skills_loaded_in(messages: Iterable[ModelMessage]) -> set[str]:
    """Skills a previous turn loaded: the model's `load_skill` calls in the stored history, and the loads code
    recorded on a tool return (`skill_load_record`, e.g. `transfers` when payments returns a draft).

    A resumed run (tool approval) or a follow-up question must see the tools of the skill it was using.
    The history is the bot's own (ADR 015), so a client can no longer claim a skill was loaded. Pre-loading
    only reveals instructions and tool names; every call is still bound by the user's tokens and the tool
    policy, and money movement still needs approval plus step-up.
    """
    loaded: set[str] = set()
    for message in messages:
        for part in message.parts:
            if isinstance(part, ToolCallPart) and part.tool_name == LOAD_SKILL and (name := _skill_named_by(part)):
                loaded.add(name)
            elif isinstance(part, ToolReturnPart):
                loaded.update(_skills_recorded_on(part))
    return loaded
