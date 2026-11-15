"""`LLM_FAULT_INJECTION` (ADR 018): which members it breaks, how, and that it shouts when on."""

import logging
from pathlib import Path

import pytest
from pydantic import ValidationError
from pydantic_ai import Agent
from pydantic_ai.exceptions import FallbackExceptionGroup

from app.core.llm.circuit_breaker import CircuitBreakerModel
from app.core.llm.fault_injection import Fault, FaultyModel, parse_faults
from app.core.llm.model_chain import ModelChain, ModelChains
from tests.conftest import make_settings


def _faults(chain: ModelChain) -> list[str | None]:
    members = [m.wrapped for m in chain.models if isinstance(m, CircuitBreakerModel)]
    return [m.kind if isinstance(m, FaultyModel) else None for m in members]


def _chains(spec: str) -> ModelChains:
    settings = make_settings().model_copy(
        update={"bot_model_fallbacks": "test", "guard_model_fallbacks": "test", "llm_fault_injection": spec}
    )
    return ModelChains.from_settings(settings)


def test_specs_parse_with_status_aliases() -> None:
    assert parse_faults("") == ()
    assert parse_faults("orchestrator:529, guard:stall") == (
        Fault("orchestrator", "overloaded"),
        Fault("guard", "stall"),
    )
    assert parse_faults("all:429") == (Fault("all", "rate_limited"),)


@pytest.mark.parametrize("spec", ["orchestrator", "bot:overloaded", "guard:teapot", "primary:418"])
def test_a_typo_fails_at_startup(spec: str) -> None:
    with pytest.raises(ValidationError, match="LLM_FAULT_INJECTION"):
        make_settings().model_validate({**make_settings().model_dump(), "llm_fault_injection": spec})


@pytest.mark.parametrize(
    ("spec", "orchestrator", "guard"),
    [
        ("orchestrator:overloaded", ["overloaded", None], [None, None]),
        ("guard:rate_limited", [None, None], ["rate_limited", None]),
        ("primary:500", ["server_error", None], ["server_error", None]),
        ("all:529", ["overloaded", "overloaded"], ["overloaded", "overloaded"]),
        ("orchestrator:after_first_event", ["after_first_event", None], [None, None]),
    ],
)
def test_targets_pick_the_members_they_break(
    spec: str, orchestrator: list[str | None], guard: list[str | None]
) -> None:
    chains = _chains(spec)
    assert _faults(chains.orchestrator) == orchestrator
    assert _faults(chains.guard) == guard


def test_no_fault_and_no_warning_by_default(caplog: pytest.LogCaptureFixture) -> None:
    chains = _chains("")
    assert _faults(chains.orchestrator) == [None, None]
    assert not [r for r in caplog.records if getattr(r, "metric", None) == "llm.fault_injection"]


def test_a_loud_warning_at_startup_when_set(caplog: pytest.LogCaptureFixture) -> None:
    _chains("primary:stall")
    [warning] = [r for r in caplog.records if getattr(r, "metric", None) == "llm.fault_injection"]
    assert warning.levelno == logging.WARNING
    assert "FAULT INJECTION IS ON" in warning.getMessage()


async def test_a_primary_fault_is_served_by_the_backup() -> None:
    result = await Agent(_chains("guard:overloaded").guard).run("hola")
    assert isinstance(result.output, str)


async def test_faulting_every_model_fails_the_request() -> None:
    with pytest.raises(FallbackExceptionGroup):
        await Agent(_chains("all:503").guard).run("hola")


def test_the_env_example_leaves_fault_injection_off() -> None:
    example = Path(__file__).resolve().parents[5] / ".env.example"
    lines = [line.strip() for line in example.read_text().splitlines()]
    assert "LLM_FAULT_INJECTION=" in lines
