from collections.abc import Iterable

from pydantic_ai.messages import ModelMessage, ModelResponse, ToolCallPart

LOAD_SKILL = "load_skill"


def _skill_named_by(call: ToolCallPart) -> str | None:
    try:
        name = call.args_as_dict().get("name")
    except ValueError:
        return None
    return name if isinstance(name, str) else None


def skills_loaded_in(messages: Iterable[ModelMessage]) -> set[str]:
    """Skills a previous turn loaded, read from the model's `load_skill` calls in the stored history.

    A resumed run (tool approval) or a follow-up question must see the tools of the skill it was using.
    The history is the bot's own (ADR 015), so a client can no longer claim a skill was loaded. Pre-loading
    only reveals instructions and tool names; every call is still bound by the user's tokens and the tool
    policy, and money movement still needs approval plus step-up.
    """
    loaded: set[str] = set()
    for message in messages:
        if not isinstance(message, ModelResponse):
            continue
        for part in message.parts:
            if isinstance(part, ToolCallPart) and part.tool_name == LOAD_SKILL and (name := _skill_named_by(part)):
                loaded.add(name)
    return loaded
