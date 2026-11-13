import pytest
from httpx import AsyncClient
from pydantic import ValidationError

from app.config import Settings
from tests.conftest import TEST_CLIENT_SECRET


async def test_health_reports_ok(client: AsyncClient) -> None:
    res = await client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "bot"}


@pytest.fixture
def bot_env(monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    monkeypatch.setenv("BOT_MODEL", "anthropic:some-model")
    monkeypatch.setenv("BOT_CLIENT_SECRET", TEST_CLIENT_SECRET)
    return monkeypatch


def test_settings_require_bot_model(bot_env: pytest.MonkeyPatch) -> None:
    bot_env.delenv("BOT_MODEL")
    with pytest.raises(ValidationError, match="bot_model"):
        Settings()


def test_settings_read_bot_model_from_the_environment(bot_env: pytest.MonkeyPatch) -> None:
    assert Settings().bot_model == "anthropic:some-model"


def test_settings_require_the_bot_client_secret(bot_env: pytest.MonkeyPatch) -> None:
    bot_env.delenv("BOT_CLIENT_SECRET")
    with pytest.raises(ValidationError, match="bot_client_secret"):
        Settings()


def test_settings_reject_a_short_bot_client_secret(bot_env: pytest.MonkeyPatch) -> None:
    bot_env.setenv("BOT_CLIENT_SECRET", "x" * 15)
    with pytest.raises(ValidationError, match="bot_client_secret"):
        Settings()


def test_settings_default_the_bank_timezone_to_buenos_aires(bot_env: pytest.MonkeyPatch) -> None:
    assert Settings().bank_timezone == "America/Argentina/Buenos_Aires"


def test_settings_reject_an_unknown_bank_timezone(bot_env: pytest.MonkeyPatch) -> None:
    bot_env.setenv("BANK_TIMEZONE", "Mars/Olympus_Mons")
    with pytest.raises(ValidationError, match="bank_timezone"):
        Settings()
