from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Bot configuration, read from the environment (12-factor)."""

    model_config = SettingsConfigDict(env_prefix="", extra="ignore")

    bot_port: int = Field(default=8000, gt=0)
    log_level: str = "info"
