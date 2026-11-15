from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from app.core.clock import DEFAULT_BANK_TIMEZONE
from app.core.llm.fault_injection import parse_faults

SKILLS_DIR = Path(__file__).resolve().parent.parent / "skills"
SUBAGENTS_DIR = Path(__file__).resolve().parent.parent / "subagents"
# The repo checkout layout; containers set KB_DIR instead (the path need not exist there).
KB_DIR = Path(__file__).resolve().parent.parent.parent.parent / "data" / "kb"


def parse_model_list(value: str) -> tuple[str, ...]:
    """A comma-separated env value; empty means no failover."""
    return tuple(name for name in (part.strip() for part in value.split(",")) if name)


class Settings(BaseSettings):
    """Bot configuration, read from the environment (12-factor)."""

    model_config = SettingsConfigDict(env_prefix="", extra="ignore")

    log_level: str = "info"
    bot_model: str  # BOT_MODEL; required so no model name is hard-coded.
    guard_model: str  # GUARD_MODEL: the input classifier and the write re-evaluation; required like bot_model.
    # Failover chains (ADR 018): comma-separated pydantic-ai model strings tried in order; empty means none.
    bot_model_fallbacks: str = "anthropic:claude-haiku-5-5"
    guard_model_fallbacks: str = "anthropic:claude-sonnet-5-5"
    # One chain per subagent, `<NAME>_AGENT_MODEL` then its fallbacks; an empty model means the orchestrator's
    # models, on a chain of the subagent's own. A subagent without these two fields fails at startup.
    payments_agent_model: str = ""
    payments_agent_model_fallbacks: str = ""
    llm_first_event_timeout_seconds: float = Field(default=10.0, gt=0)  # Orchestrator, per model tried.
    llm_request_timeout_seconds: float = Field(default=90.0, gt=0)
    # Per guard attempt: two fit inside the guards' 15 s fail-closed budget (ADR 014).
    guard_request_timeout_seconds: float = Field(default=6.0, gt=0)
    llm_fault_injection: str = ""  # Local runs only: see app/core/llm/fault_injection.py.
    idp_issuer: str = "http://localhost:3000"
    idp_jwks_url: str = "http://localhost:3000/.well-known/jwks.json"
    idp_token_url: str = "http://localhost:3000/token"  # noqa: S105 (a URL)
    bot_client_id: str = "bot"
    # Required with the BFF's minimum length, so a missing secret fails at startup, not on the first exchange.
    bot_client_secret: str = Field(min_length=16, repr=False)
    mcp_gateway_url: str = "http://localhost:8100/mcp"
    skills_dir: Path = SKILLS_DIR
    subagents_dir: Path = SUBAGENTS_DIR
    kb_dir: Path = KB_DIR
    database_url: str = "postgresql://bank:bank@localhost:5432/bank"
    embedding_model: str = "sentence-transformers/paraphrase-multilingual-mpnet-base-v2"
    embedding_cache_dir: str | None = None
    bank_timezone: str = DEFAULT_BANK_TIMEZONE  # The bank's day for "today" and open-ended periods.
    otel_exporter_otlp_endpoint: str | None = None
    otel_service_name: str = "bot"

    def subagent_models(self, name: str) -> tuple[str, ...]:
        """The subagent's model chain: its own `<NAME>_AGENT_MODEL` and fallbacks, or else the orchestrator's.

        Raises ValueError for a subagent with no such fields, so a new subagent file cannot run on a model nobody
        chose for it.
        """
        model_field, fallbacks_field = f"{name}_agent_model", f"{name}_agent_model_fallbacks"
        if not {model_field, fallbacks_field} <= type(self).model_fields.keys():
            raise ValueError(f"subagent {name!r} has no {model_field} and {fallbacks_field} settings")
        model = str(getattr(self, model_field)).strip()
        if not model:
            return (self.bot_model, *parse_model_list(self.bot_model_fallbacks))
        return (model, *parse_model_list(str(getattr(self, fallbacks_field))))

    @field_validator("llm_fault_injection")
    @classmethod
    def _known_faults(cls, value: str) -> str:
        parse_faults(value)  # A typo fails at startup instead of silently injecting nothing.
        return value

    @field_validator("bank_timezone")
    @classmethod
    def _known_timezone(cls, value: str) -> str:
        try:
            ZoneInfo(value)  # An unknown zone fails at startup, not on the first chat.
        except ZoneInfoNotFoundError as error:
            raise ValueError(f"unknown time zone {value!r}") from error
        return value
