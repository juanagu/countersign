"""`LLM_FAULT_INJECTION`: make chain members fail on purpose, for tests and the failover demo (ADR 018).

A spec is comma-separated `target:fault` entries. Targets: `orchestrator` or `guard` (that role's primary),
`primary` (the primary of every chain, each subagent's included), `all` (every model of every chain). A subagent
cannot be named alone; its chain shares the breakers, keyed by model name, so a fault that opens a model's breaker
also skips that model in every chain that lists it. Faults: `rate_limited` (or `429`),
`overloaded` (`529`), `unavailable` (`503`), `server_error` (`500`), `connection`, `stall` (never answers, so
a deadline fires) and `after_first_event` (a streamed request fails after its first event; others pass).
Never set outside local runs.
"""

import asyncio
import math
from collections.abc import AsyncGenerator, AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any

from pydantic_ai import RunContext
from pydantic_ai.exceptions import (
    ModelAPIError,
    ModelConnectionError,
    ModelOverloadedError,
    ModelRateLimitError,
    ModelServerError,
    ModelUnavailableError,
)
from pydantic_ai.messages import ModelMessage, ModelResponse, ModelResponseStreamEvent
from pydantic_ai.models import Model, ModelRequestParameters, StreamedResponse
from pydantic_ai.models.wrapper import WrapperModel
from pydantic_ai.settings import ModelSettings

INJECTED = "injected fault"
# The roles a target can name alone. `primary` and `all` also reach each subagent's chain (its role is its name).
ROLES = ("orchestrator", "guard")
_ERRORS: dict[str, type[ModelAPIError]] = {
    "rate_limited": ModelRateLimitError,
    "overloaded": ModelOverloadedError,
    "unavailable": ModelUnavailableError,
    "server_error": ModelServerError,
    "connection": ModelConnectionError,
}
_ALIASES = {"429": "rate_limited", "529": "overloaded", "503": "unavailable", "500": "server_error"}
_BEHAVIOURS = ("stall", "after_first_event")
FAULTS = frozenset({*_ERRORS, *_BEHAVIOURS})
TARGETS = frozenset({*ROLES, "primary", "all"})


@dataclass(frozen=True)
class Fault:
    target: str
    kind: str

    def applies_to(self, role: str, position: int) -> bool:
        if self.target == "all":
            return True
        return position == 0 and self.target in (role, "primary")


def parse_faults(spec: str) -> tuple[Fault, ...]:
    faults: list[Fault] = []
    for entry in filter(None, (part.strip() for part in spec.split(","))):
        target, _, kind = entry.partition(":")
        kind = _ALIASES.get(kind, kind)
        if target not in TARGETS or kind not in FAULTS:
            raise ValueError(f"invalid LLM_FAULT_INJECTION entry {entry!r}")
        faults.append(Fault(target, kind))
    return tuple(faults)


def fault_for(faults: tuple[Fault, ...], role: str, position: int) -> str | None:
    return next((fault.kind for fault in faults if fault.applies_to(role, position)), None)


class FaultyModel(WrapperModel):
    """Fails every request to the wrapped model the way `kind` says."""

    def __init__(self, wrapped: Model, kind: str) -> None:
        if kind not in FAULTS:
            raise ValueError(f"unknown fault {kind!r}")
        super().__init__(wrapped)
        self.kind = kind

    async def _before_request(self) -> None:
        if self.kind == "stall":
            await asyncio.sleep(math.inf)
        if (error := _ERRORS.get(self.kind)) is not None:
            raise error(self.model_name, INJECTED)

    async def request(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
    ) -> ModelResponse:
        await self._before_request()
        return await super().request(messages, model_settings, model_request_parameters)

    @asynccontextmanager
    async def request_stream(
        self,
        messages: list[ModelMessage],
        model_settings: ModelSettings | None,
        model_request_parameters: ModelRequestParameters,
        run_context: RunContext[Any] | None = None,
    ) -> AsyncGenerator[StreamedResponse]:
        await self._before_request()
        async with super().request_stream(messages, model_settings, model_request_parameters, run_context) as stream:
            if self.kind == "after_first_event":
                self._fail_after_first(stream)
            yield stream

    def _fail_after_first(self, stream: StreamedResponse) -> None:
        """The provider's own events pass, under the deadlines the caller arms; the second pull fails."""
        provider_events = stream._get_event_iterator
        model_name = self.model_name

        async def failing() -> AsyncIterator[ModelResponseStreamEvent]:
            yield await anext(provider_events())
            raise ModelServerError(model_name, INJECTED)

        stream._get_event_iterator = failing  # type: ignore[method-assign]
