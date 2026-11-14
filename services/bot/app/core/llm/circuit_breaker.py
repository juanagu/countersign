"""Skip a model that keeps failing: for the rest of a run after one failure, process-wide after a burst (ADR 018)."""

import logging
import time
from collections import deque
from collections.abc import AsyncGenerator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from pydantic_ai import RunContext
from pydantic_ai.exceptions import ModelUnavailableError
from pydantic_ai.messages import ModelMessage, ModelResponse
from pydantic_ai.models import Model, ModelRequestParameters, StreamedResponse
from pydantic_ai.models.wrapper import WrapperModel
from pydantic_ai.settings import ModelSettings

from app.core.llm.run_record import current_run_record

logger = logging.getLogger(__name__)

OPENED_METRIC = "llm.circuit.opened"
CLOSED_METRIC = "llm.circuit.closed"
FAILURE_THRESHOLD = 3
FAILURE_WINDOW_SECONDS = 60.0
OPEN_SECONDS = 30.0


class CircuitOpenError(ModelUnavailableError):
    """Raised before any I/O while a model is skipped, so the chain moves on at once."""

    def __init__(self, model_name: str) -> None:
        super().__init__(model_name, "circuit open")


@dataclass
class CircuitBreaker:
    """One model's process-wide state: closed, open for `open_seconds`, then one probe decides."""

    model_name: str
    clock: Callable[[], float] = time.monotonic
    threshold: int = FAILURE_THRESHOLD
    window_seconds: float = FAILURE_WINDOW_SECONDS
    open_seconds: float = OPEN_SECONDS
    _failures: deque[float] = field(default_factory=deque)
    _opened_at: float | None = None
    _probe_started_at: float | None = None

    @property
    def is_open(self) -> bool:
        return self._opened_at is not None

    def allows_request(self) -> bool:
        if self._opened_at is None:
            return True
        now = self.clock()
        if now - self._opened_at < self.open_seconds:
            return False
        # A probe that never reported back (cancelled) doesn't hold the breaker open forever.
        if self._probe_started_at is not None and now - self._probe_started_at < self.open_seconds:
            return False
        self._probe_started_at = now
        return True

    def record_failure(self) -> None:
        now = self.clock()
        if self._opened_at is not None:
            self._open(now)  # The probe failed.
            return
        self._failures.append(now)
        while self._failures and now - self._failures[0] > self.window_seconds:
            self._failures.popleft()
        if len(self._failures) >= self.threshold:
            self._open(now)

    def record_success(self) -> None:
        if self._opened_at is None:
            return
        self._opened_at = self._probe_started_at = None
        self._failures.clear()
        logger.info("model circuit closed", extra={"metric": CLOSED_METRIC, "model": self.model_name})

    def _open(self, now: float) -> None:
        was_open = self._opened_at is not None
        self._opened_at, self._probe_started_at = now, None
        self._failures.clear()
        if not was_open:
            logger.warning("model circuit opened", extra={"metric": OPENED_METRIC, "model": self.model_name})


@dataclass
class BreakerRegistry:
    """Breakers by model name, shared by both roles: an overloaded model is overloaded for every caller."""

    clock: Callable[[], float] = time.monotonic
    _breakers: dict[str, CircuitBreaker] = field(default_factory=dict)

    def for_model(self, model_name: str) -> CircuitBreaker:
        if model_name not in self._breakers:
            self._breakers[model_name] = CircuitBreaker(model_name, clock=self.clock)
        return self._breakers[model_name]


class CircuitBreakerModel(WrapperModel):
    """A chain member. `skippable` members raise `CircuitOpenError` while skipped; the chain's last one never is.

    Every member records the model that answered on the current run record, and success with its breaker.
    """

    def __init__(self, wrapped: Model, *, role: str, breaker: CircuitBreaker, skippable: bool) -> None:
        super().__init__(wrapped)
        self.role = role
        self.breaker = breaker
        self.skippable = skippable

    def _check_open(self) -> None:
        if not self.skippable:
            return
        record = current_run_record()
        if record is not None and self.model_name in record.failed_models:
            raise CircuitOpenError(self.model_name)
        if not self.breaker.allows_request():
            raise CircuitOpenError(self.model_name)

    def _served(self) -> None:
        self.breaker.record_success()
        if (record := current_run_record()) is not None:
            record.record_served(self.role, self.model_name)

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        self._check_open()
        response = await super().request(messages, model_settings, model_request_parameters)
        self._served()
        return response

    @asynccontextmanager
    async def request_stream(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
        run_context: RunContext[Any] | None = None,
    ) -> AsyncGenerator[StreamedResponse]:
        self._check_open()
        async with super().request_stream(messages, model_settings, model_request_parameters, run_context) as stream:
            yield stream
        self._served()
