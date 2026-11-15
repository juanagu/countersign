from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, UserPromptPart

from app.skills.history import skills_loaded_in


def test_reads_skills_loaded_by_earlier_model_turns() -> None:
    messages = [
        ModelRequest(parts=[UserPromptPart("hola")]),
        ModelResponse(parts=[ToolCallPart("load_skill", {"name": "payments"})]),
        ModelResponse(parts=[ToolCallPart("list_accounts", {}), ToolCallPart("load_skill", '{"name": "accounts"}')]),
    ]
    assert skills_loaded_in(messages) == {"payments", "accounts"}


def test_ignores_other_tools_and_malformed_calls() -> None:
    messages = [
        ModelResponse(parts=[ToolCallPart("load_skill", "not json")]),
        ModelResponse(parts=[ToolCallPart("load_skill", {"name": 7})]),
        ModelResponse(parts=[TextPart("load_skill payments")]),
    ]
    assert skills_loaded_in(messages) == set()
