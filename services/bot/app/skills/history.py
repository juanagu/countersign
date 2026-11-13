import json
from collections.abc import Iterable, Mapping
from typing import Any

LOAD_SKILL = "load_skill"


def skills_loaded_in(messages: Iterable[Mapping[str, Any]]) -> set[str]:
    """Skills a previous turn loaded, read from AG-UI assistant tool calls.

    A resumed run (tool approval) or a follow-up question must see the tools of the skill it was using.
    Pre-loading a skill only reveals instructions and tool names; every call is still bound by the user's
    tokens and the tool policy, and money movement still needs approval plus step-up.
    """
    loaded: set[str] = set()
    for message in messages:
        if message.get("role") != "assistant":
            continue
        for call in message.get("toolCalls") or []:
            function = call.get("function") or {}
            if function.get("name") != LOAD_SKILL:
                continue
            try:
                name = json.loads(function.get("arguments") or "{}").get("name")
            except (ValueError, AttributeError):
                continue
            if isinstance(name, str):
                loaded.add(name)
    return loaded
