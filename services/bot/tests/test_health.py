import pytest
from httpx import ASGITransport, AsyncClient
from pydantic import ValidationError

from app.config import Settings
from app.main import create_app


async def test_health_reports_ok() -> None:
    async with AsyncClient(transport=ASGITransport(app=create_app()), base_url="http://test") as client:
        res = await client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok", "service": "bot"}


def test_settings_reject_non_numeric_port(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("BOT_PORT", "abc")
    with pytest.raises(ValidationError):
        Settings()
