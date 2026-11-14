from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.chat.agent import build_agent
from app.chat.deps import BotDeps
from app.config import SKILLS_DIR
from app.skills.registry import SkillRegistry


async def test_every_orchestrator_request_asks_for_prompt_caching() -> None:
    settings: list[dict[str, object]] = []

    def respond(_: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        settings.append(dict(info.model_settings or {}))
        return ModelResponse(parts=[TextPart("ok")])

    agent = build_agent(FunctionModel(respond), skills=SkillRegistry.from_dir(SKILLS_DIR))
    await agent.run("hola", deps=BotDeps(user_id="ana", access_token="t"))

    assert settings[0]["anthropic_cache_tool_definitions"] is True
    assert settings[0]["anthropic_cache_instructions"] is True
    assert settings[0]["anthropic_cache"] is True
