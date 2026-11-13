from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Bot configuration, read from the environment (12-factor)."""

    model_config = SettingsConfigDict(env_prefix="", extra="ignore")

    bot_port: int = Field(default=8000, gt=0)
    log_level: str = "info"
    bot_model: str  # BOT_MODEL; required so no model name is hard-coded.
    idp_issuer: str = "http://localhost:3000"
    idp_jwks_url: str = "http://localhost:3000/.well-known/jwks.json"
    otel_exporter_otlp_endpoint: str | None = None
    otel_service_name: str = "bot"
