import pytest
from httpx import AsyncClient
from pydantic import ValidationError

from app.config import Settings


async def test_health_reports_ok(client: AsyncClient) -> None:
    res = await client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "bot"}


def test_settings_reject_non_numeric_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOT_PORT", "abc")
    with pytest.raises(ValidationError):
        Settings()
