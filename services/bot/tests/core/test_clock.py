from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.chat.agent import build_agent
from app.chat.deps import BotDeps
from app.config import SKILLS_DIR
from app.core.clock import BankClock
from app.skills.registry import SkillRegistry

# 22:00 in Buenos Aires on Nov 30 is already Dec 1 in UTC, where the container runs.
LATE_NOV_30_ART = BankClock(now=lambda: datetime(2026, 12, 1, 1, 0, tzinfo=UTC))


def test_today_is_the_banks_day_not_utcs() -> None:
    assert LATE_NOV_30_ART.today() == date(2026, 11, 30)
    assert BankClock(ZoneInfo("UTC"), LATE_NOV_30_ART.now).today() == date(2026, 12, 1)


async def test_the_agent_tells_the_model_the_banks_today() -> None:
    instructions: list[str] = []

    def respond(_: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        instructions.append(info.instructions or "")
        return ModelResponse(parts=[TextPart("ok")])

    agent = build_agent(FunctionModel(respond), skills=SkillRegistry.from_dir(SKILLS_DIR), clock=LATE_NOV_30_ART)
    await agent.run("hola", deps=BotDeps(user_id="ana", access_token="t"))

    assert "Today is 2026-11-30." in instructions[0]
