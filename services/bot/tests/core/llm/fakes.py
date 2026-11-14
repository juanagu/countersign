"""FunctionModel fakes for the failover chains: named, counting their calls, failing on demand."""

import asyncio
import math
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field

from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart
from pydantic_ai.models.function import AgentInfo, DeltaToolCalls, FunctionModel
from pydantic_ai.settings import ModelSettings

from app.core.llm.circuit_breaker import BreakerRegistry
from app.core.llm.model_chain import ModelChain, build_model_chain

FAST = ModelSettings(first_event_timeout=0.05, request_timeout=0.2)
# Synthetic PII a provider error could quote back; no regex redacts a bare name, so it must never be logged.
PII_ERROR = "prompt was: Lucía Fernández, DNI 30.123.456, juan.perez@example.com"


@dataclass
class Fake:
    """A named model answering `text`, or raising `error()` before its first event."""

    name: str
    text: str = "Hola. Te ayudo."
    error: Callable[[str], Exception] | None = None
    stall: bool = False
    calls: list[str] = field(default_factory=list)

    async def _maybe_fail(self) -> None:
        self.calls.append(self.name)
        if self.stall:
            await asyncio.sleep(math.inf)
        if self.error is not None:
            raise self.error(self.name)

    async def _respond(self, _: list[ModelMessage], __: AgentInfo) -> ModelResponse:
        await self._maybe_fail()
        return ModelResponse(parts=[TextPart(self.text)])

    async def _stream(self, _: list[ModelMessage], __: AgentInfo) -> AsyncIterator[str | DeltaToolCalls]:
        await self._maybe_fail()
        for word in self.text.split(" "):
            yield word + " "

    def model(self) -> FunctionModel:
        return FunctionModel(self._respond, stream_function=self._stream, model_name=self.name)


def chain(*fakes: Fake, breakers: BreakerRegistry | None = None, role: str = "orchestrator") -> ModelChain:
    return build_model_chain(
        role, [fake.model() for fake in fakes], settings=FAST, breakers=breakers or BreakerRegistry()
    )
