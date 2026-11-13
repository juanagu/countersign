import pytest
from httpx import AsyncClient
from pydantic import ValidationError

from app.config import Settings
from tests.conftest import TEST_MODEL


async def test_health_reports_ok(client: AsyncClient) -> None:
    res = await client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "bot"}


def test_settings_reject_non_numeric_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOT_PORT", "abc")
    with pytest.raises(ValidationError, match="bot_port"):
        Settings(bot_model=TEST_MODEL)


def test_settings_require_bot_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("BOT_MODEL", raising=False)
    with pytest.raises(ValidationError, match="bot_model"):
        Settings()


def test_settings_read_bot_model_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOT_MODEL", "anthropic:some-model")
    assert Settings().bot_model == "anthropic:some-model"
