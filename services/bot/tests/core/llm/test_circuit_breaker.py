"""The breaker (ADR 018): a model that failed is skipped for the rest of the run, and process-wide after a burst."""

import logging

import pytest
from pydantic_ai import Agent
from pydantic_ai.exceptions import FallbackExceptionGroup, ModelOverloadedError

from app.core.llm.circuit_breaker import BreakerRegistry, CircuitBreaker
from app.core.llm.run_record import start_run_record
from tests.core.llm.fakes import Fake, chain


class FakeClock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def _overloaded(name: str) -> Exception:
    return ModelOverloadedError(name, "overloaded")


async def _run_once(primary: Fake, backup: Fake, breakers: BreakerRegistry) -> str:
    start_run_record()  # Each chat run gets its own record, as `chat/routes.py` does.
    return str((await Agent(chain(primary, backup, breakers=breakers)).run("hola")).output)


async def test_a_model_that_failed_is_skipped_for_the_rest_of_the_run() -> None:
    primary, backup = Fake("primary", error=_overloaded), Fake("backup")
    model = chain(primary, backup)
    record = start_run_record()
    for _ in range(3):  # Three steps of one run.
        await Agent(model).run("hola")
    assert primary.calls == ["primary"]
    assert backup.calls == ["backup"] * 3
    assert record.failovers == 3  # The two skips are failovers too, with reason `circuit_open`.


async def test_a_new_run_tries_the_primary_again() -> None:
    primary, backup, breakers = Fake("primary", error=_overloaded), Fake("backup"), BreakerRegistry()
    await _run_once(primary, backup, breakers)
    await _run_once(primary, backup, breakers)
    assert primary.calls == ["primary", "primary"]


async def test_three_failures_in_a_minute_open_the_breaker_and_a_probe_closes_it(
    caplog: pytest.LogCaptureFixture,
) -> None:
    caplog.set_level(logging.INFO)
    clock = FakeClock()
    breakers = BreakerRegistry(clock=clock)
    primary, backup = Fake("primary", error=_overloaded), Fake("backup")
    for _ in range(3):
        await _run_once(primary, backup, breakers)
        clock.now += 10
    assert breakers.for_model("primary").is_open

    await _run_once(primary, backup, breakers)
    assert len(primary.calls) == 3  # Skipped before any I/O while open.

    clock.now += 30
    primary.error = None  # The primary recovered; the next request probes it.
    assert await _run_once(primary, backup, breakers) == primary.text
    assert len(primary.calls) == 4
    assert not breakers.for_model("primary").is_open
    metrics = [getattr(r, "metric", None) for r in caplog.records]
    assert metrics.count("llm.circuit.opened") == 1 and metrics.count("llm.circuit.closed") == 1


async def test_a_failed_probe_opens_the_breaker_again() -> None:
    clock = FakeClock()
    breaker = CircuitBreaker("primary", clock=clock)
    for _ in range(3):
        breaker.record_failure()
    clock.now += 30
    assert breaker.allows_request()  # The probe.
    assert not breaker.allows_request()  # Only one at a time.
    breaker.record_failure()
    clock.now += 29
    assert not breaker.allows_request()


def test_failures_spread_over_more_than_a_minute_do_not_open_it() -> None:
    clock = FakeClock()
    breaker = CircuitBreaker("primary", clock=clock)
    for _ in range(5):
        breaker.record_failure()
        clock.now += 31
    assert not breaker.is_open


async def test_the_last_model_of_a_chain_is_never_skipped() -> None:
    clock = FakeClock()
    breakers = BreakerRegistry(clock=clock)
    only = Fake("only", error=_overloaded)
    for _ in range(4):
        start_run_record()
        with pytest.raises(FallbackExceptionGroup):
            await Agent(chain(only, breakers=breakers)).run("hola")
    assert len(only.calls) == 4
