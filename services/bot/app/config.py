from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"


class Settings(BaseSettings):
    """Bot configuration, read from the environment (12-factor)."""

    model_config = SettingsConfigDict(env_prefix="", extra="ignore")

    bot_port: int = Field(default=8000, gt=0)
    log_level: str = "info"
    bot_model: str = "anthropic:claude-sonnet-5-5"
    idp_issuer: str = "http://localhost:3000"
    idp_jwks_url: str = "http://localhost:3000/.well-known/jwks.json"
    idp_token_url: str = "http://localhost:3000/token"  # noqa: S105 (a URL)
    bot_client_id: str = "bot"
    bot_client_secret: str = Field(default="", repr=False)
    mcp_accounts_url: str = "http://localhost:8101/mcp"
    mcp_payments_url: str = "http://localhost:8102/mcp"
    skills_dir: Path = SKILLS_DIR
    otel_exporter_otlp_endpoint: str | None = None
    otel_service_name: str = "bot"
