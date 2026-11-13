import pytest
from httpx import AsyncClient
from pydantic import ValidationError

from app.config import Settings


async def test_health_reports_ok(client: AsyncClient) -> None:
    res = await client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "bot"}


def test_settings_require_bot_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BOT_MODEL", raising=False)
    with pytest.raises(ValidationError, match="bot_model"):
        Settings()


def test_settings_read_bot_model_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOT_MODEL", "anthropic:some-model")
    assert Settings().bot_model == "anthropic:some-model"
