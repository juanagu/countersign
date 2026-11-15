from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, UserPromptPart

from app.config import SKILLS_DIR
from app.skills.history import replayed_skills, skills_loaded_in
from app.skills.registry import SkillRegistry
from tests.conftest import TEST_SKILLS_DIR


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


def test_a_replay_names_a_renamed_skill_by_its_new_name_and_drops_unknown_ones() -> None:
    messages = [
        ModelResponse(parts=[ToolCallPart("load_skill", {"name": "payments"})]),
        ModelResponse(parts=[ToolCallPart("load_skill", {"name": "accounts"})]),
        ModelResponse(parts=[ToolCallPart("load_skill", {"name": "retired"})]),
    ]
    assert replayed_skills(messages, SkillRegistry.from_dir(SKILLS_DIR)) == {"transfers", "accounts"}
    # Where the old skill still exists (the mechanism tests' fixture), it is kept as it is.
    assert replayed_skills(messages, SkillRegistry.from_dir(TEST_SKILLS_DIR)) == {"payments", "accounts"}
