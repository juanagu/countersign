from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
# The repo checkout layout; containers set KB_DIR instead (the path need not exist there).
KB_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data" / "kb"


class Settings(BaseSettings):
    """Bot configuration, read from the environment (12-factor)."""

    model_config = SettingsConfigDict(env_prefix="", extra="ignore")

    log_level: str = "info"
    bot_model: str  # BOT_MODEL; required so no model name is hard-coded.
    idp_issuer: str = "http://localhost:3000"
    idp_jwks_url: str = "http://localhost:3000/.well-known/jwks.json"
    idp_token_url: str = "http://localhost:3000/token"  # noqa: S105 (a URL)
    bot_client_id: str = "bot"
    # Required with the BFF's minimum length, so a missing secret fails at startup, not on the first exchange.
    bot_client_secret: str = Field(min_length=16, repr=False)
    mcp_accounts_url: str = "http://localhost:8101/mcp"
    mcp_payments_url: str = "http://localhost:8102/mcp"
    skills_dir: Path = SKILLS_DIR
    kb_dir: Path = KB_DIR
    database_url: str = "postgresql://bank:bank@localhost:5432/bank"
    embedding_model: str = "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"
    embedding_cache_dir: str | None = None
    otel_exporter_otlp_endpoint: str | None = None
    otel_service_name: str = "bot"
