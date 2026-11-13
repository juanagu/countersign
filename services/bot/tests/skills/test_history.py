from app.skills.history import skills_loaded_in


def _call(name: str, arguments: str) -> dict[str, object]:
    return {"id": "c", "type": "function", "function": {"name": name, "arguments": arguments}}


def test_reads_skills_loaded_by_earlier_assistant_turns() -> None:
    messages = [
        {"role": "user", "content": "hola"},
        {"role": "assistant", "toolCalls": [_call("load_skill", '{"name": "payments"}')]},
        {"role": "tool", "content": "...", "toolCallId": "c"},
        {"role": "assistant", "toolCalls": [_call("list_accounts", "{}"), _call("load_skill", '{"name": "accounts"}')]},
    ]
    assert skills_loaded_in(messages) == {"payments", "accounts"}


def test_ignores_non_assistant_and_malformed_calls() -> None:
    messages = [
        {"role": "user", "toolCalls": [_call("load_skill", '{"name": "payments"}')]},
        {"role": "assistant", "toolCalls": [_call("load_skill", "not json")]},
        {"role": "assistant", "toolCalls": [_call("load_skill", '{"name": 7}')]},
        {"role": "assistant", "toolCalls": None},
    ]
    assert skills_loaded_in(messages) == set()
