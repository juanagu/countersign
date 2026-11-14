"""The failover chain (ADR 018): what fails over, the deadlines, and what a stream that already started does."""

import logging
from collections.abc import Callable

import pytest
from pydantic_ai import Agent, AgentRunResultEvent
from pydantic_ai.exceptions import (
    FallbackExceptionGroup,
    ModelAuthenticationError,
    ModelConnectionError,
    ModelContextWindowExceededError,
    ModelHTTPError,
    ModelNotFoundError,
    ModelOverloadedError,
    ModelQuotaExceededError,
    ModelRateLimitError,
    ModelRequestRejectedError,
    ModelServerError,
    ModelTimeoutError,
    ModelUnavailableError,
)

from app.core.llm.circuit_breaker import BreakerRegistry
from app.core.llm.fault_injection import FaultyModel
from app.core.llm.model_chain import ModelChain, ModelChains, build_model_chain, parse_model_list
from app.core.llm.run_record import current_run_record, start_run_record
from tests.conftest import make_settings
from tests.core.llm.fakes import FAST, PII_ERROR, Fake, chain

Raise = Callable[[str], Exception]

FAILS_OVER: dict[str, Raise] = {
    "rate_limited": lambda name: ModelRateLimitError(name, PII_ERROR),
    "overloaded": lambda name: ModelOverloadedError(name, PII_ERROR),
    "unavailable": lambda name: ModelUnavailableError(name, PII_ERROR),
    "server_error": lambda name: ModelServerError(name, PII_ERROR),
    "connection": lambda name: ModelConnectionError(name, PII_ERROR),
    "transport_timeout": lambda name: ModelTimeoutError(name, PII_ERROR),
    "http_529": lambda name: ModelHTTPError(529, name, PII_ERROR),
    "http_502": lambda name: ModelHTTPError(502, name, PII_ERROR),
}
SURFACES: dict[str, Raise] = {
    "auth": lambda name: ModelAuthenticationError(name, PII_ERROR),
    "not_found": lambda name: ModelNotFoundError(name, PII_ERROR),
    "context_window": lambda name: ModelContextWindowExceededError(name, PII_ERROR),
    "rejected": lambda name: ModelRequestRejectedError(name, PII_ERROR),
    "quota": lambda name: ModelQuotaExceededError(name, PII_ERROR),
    "http_400": lambda name: ModelHTTPError(400, name, PII_ERROR),
    "a_bug": lambda _: RuntimeError(PII_ERROR),
}


async def _stream_text(model: ModelChain) -> str:
    async with Agent(model).run_stream_events("hola") as events:
        async for event in events:
            if isinstance(event, AgentRunResultEvent):
                return str(event.result.output)
    raise AssertionError("the run ended without a result")


@pytest.mark.parametrize("error", FAILS_OVER.values(), ids=FAILS_OVER.keys())
async def test_transient_failures_fall_back_to_the_next_model(error: Raise) -> None:
    primary, backup = Fake("primary", error=error), Fake("backup", text="Respuesta del backup.")
    result = await Agent(chain(primary, backup)).run("hola")
    assert result.output == "Respuesta del backup."
    assert primary.calls == ["primary"] and backup.calls == ["backup"]


@pytest.mark.parametrize("error", FAILS_OVER.values(), ids=FAILS_OVER.keys())
async def test_transient_failures_before_the_first_event_fall_back_when_streamed(error: Raise) -> None:
    primary, backup = Fake("primary", error=error), Fake("backup", text="Respuesta del backup.")
    assert (await _stream_text(chain(primary, backup))).strip() == "Respuesta del backup."


@pytest.mark.parametrize("error", SURFACES.values(), ids=SURFACES.keys())
async def test_configuration_errors_and_bugs_surface_without_trying_the_backup(error: Raise) -> None:
    primary, backup = Fake("primary", error=error), Fake("backup")
    with pytest.raises(Exception, match="Lucía") as raised:
        await Agent(chain(primary, backup)).run("hola")
    assert not isinstance(raised.value, FallbackExceptionGroup)
    assert backup.calls == []


async def test_a_stall_past_the_first_event_deadline_falls_back() -> None:
    primary, backup = Fake("primary", stall=True), Fake("backup", text="Llegó el backup.")
    assert (await _stream_text(chain(primary, backup))).strip() == "Llegó el backup."


async def test_a_non_streamed_stall_past_the_request_deadline_falls_back() -> None:
    primary, backup = Fake("primary", stall=True), Fake("backup", text="Llegó el backup.")
    assert (await Agent(chain(primary, backup)).run("hola")).output == "Llegó el backup."


async def test_a_fault_after_the_first_event_is_not_failed_over() -> None:
    primary, backup = Fake("primary"), Fake("backup")
    model = build_model_chain(
        "orchestrator",
        [FaultyModel(primary.model(), "after_first_event"), backup.model()],
        settings=FAST,
        breakers=BreakerRegistry(),
    )
    with pytest.raises(ModelServerError):
        await _stream_text(model)
    assert backup.calls == []


async def test_when_every_model_fails_the_run_fails() -> None:
    overloaded = FAILS_OVER["overloaded"]
    with pytest.raises(FallbackExceptionGroup):
        await Agent(chain(Fake("primary", error=overloaded), Fake("backup", error=overloaded))).run("hola")


async def test_the_run_record_names_the_model_that_answered_and_counts_failovers() -> None:
    record = start_run_record()
    await Agent(chain(Fake("primary", error=FAILS_OVER["overloaded"]), Fake("backup"))).run("hola")
    assert record is current_run_record()
    assert record.span_attributes() == {"bot.models_served": ["orchestrator:backup"], "bot.failovers": 1}


async def test_each_failover_logs_its_role_model_and_reason_class(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level(logging.INFO)
    await Agent(chain(Fake("primary", error=FAILS_OVER["rate_limited"]), Fake("backup"), role="guard")).run("hola")
    [line] = [r for r in caplog.records if getattr(r, "metric", None) == "llm.failover"]
    assert (line.role, line.from_model, line.to_model, line.reason, line.attempt) == (  # type: ignore[attr-defined]
        "guard",
        "primary",
        "backup",
        "rate_limited",
        1,
    )


async def test_the_failover_log_never_carries_the_error_message(caplog: pytest.LogCaptureFixture) -> None:
    """Rule 7: a provider error can quote the prompt, names included, which no pattern redacts."""
    caplog.set_level(logging.DEBUG)
    await Agent(chain(Fake("primary", error=FAILS_OVER["server_error"]), Fake("backup"))).run("hola")
    failover = [r for r in caplog.records if str(getattr(r, "metric", "")).startswith("llm.")]
    assert failover
    for record in failover:
        assert record.exc_info is None
        assert "Lucía" not in record.getMessage()
        assert not any("Lucía" in str(value) for value in vars(record).values())


def test_fallback_lists_parse_from_comma_separated_env_values() -> None:
    assert parse_model_list("") == ()
    assert parse_model_list(" anthropic:a , openai:b,") == ("anthropic:a", "openai:b")


def test_chains_from_settings_give_each_role_its_deadlines_and_backups() -> None:
    settings = make_settings().model_copy(update={"bot_model_fallbacks": "test", "guard_model_fallbacks": ""})
    chains = ModelChains.from_settings(settings)
    assert len(chains.orchestrator.models) == 2 and len(chains.guard.models) == 1
    assert chains.orchestrator.settings == {"first_event_timeout": 10.0, "request_timeout": 90.0}
    assert chains.guard.settings == {"request_timeout": 6.0}


def test_the_default_backups_are_the_other_claude_model() -> None:
    fields = type(make_settings()).model_fields
    assert fields["bot_model_fallbacks"].default == "anthropic:claude-haiku-5-5"
    assert fields["guard_model_fallbacks"].default == "anthropic:claude-sonnet-5-5"
