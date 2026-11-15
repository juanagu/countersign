"""One `FallbackModel` chain per role, built here and handed to every `Model | str` parameter (ADR 018)."""

import logging
from collections.abc import Sequence
from dataclasses import dataclass

from pydantic_ai.models import Model, infer_model
from pydantic_ai.models.fallback import FallbackModel
from pydantic_ai.settings import ModelSettings

from app.config import Settings
from app.core.llm.circuit_breaker import BreakerRegistry, CircuitBreakerModel
from app.core.llm.failover import failover_handler
from app.core.llm.fault_injection import Fault, FaultyModel, fault_for, parse_faults

logger = logging.getLogger(__name__)

ORCHESTRATOR = "orchestrator"
GUARD = "guard"
FAULT_INJECTION_METRIC = "llm.fault_injection"


class ModelChain(FallbackModel):
    """A `FallbackModel` whose own settings carry the role's deadlines, so each member gets fresh ones."""

    def __init__(self, role: str, members: Sequence[Model], *, settings: ModelSettings, breakers: BreakerRegistry):
        names = [member.model_name for member in members]
        super().__init__(*members, fallback_on=failover_handler(role, names, breakers))
        self.role = role
        self._role_settings = settings

    @property
    def settings(self) -> ModelSettings | None:
        return self._role_settings


def parse_model_list(value: str) -> tuple[str, ...]:
    """A comma-separated env value; empty means no failover."""
    return tuple(name for name in (part.strip() for part in value.split(",")) if name)


def build_model_chain(
    role: str,
    models: Sequence[Model | str],
    *,
    settings: ModelSettings,
    breakers: BreakerRegistry,
    faults: tuple[Fault, ...] = (),
) -> ModelChain:
    """Every member but the last can be skipped by its breaker; `faults` wrap the members they target."""
    if not models:
        raise ValueError(f"the {role} chain needs at least one model")
    members: list[Model] = []
    last = len(models) - 1
    for position, spec in enumerate(models):
        model = infer_model(spec)
        if (kind := fault_for(faults, role, position)) is not None:
            model = FaultyModel(model, kind)
        breaker = breakers.for_model(model.model_name)
        members.append(CircuitBreakerModel(model, role=role, breaker=breaker, skippable=position < last))
    return ModelChain(role, members, settings=settings, breakers=breakers)


@dataclass(frozen=True)
class ModelChains:
    orchestrator: ModelChain
    guard: ModelChain

    @classmethod
    def from_settings(cls, settings: Settings, breakers: BreakerRegistry | None = None) -> "ModelChains":
        breakers = breakers or BreakerRegistry()
        faults = parse_faults(settings.llm_fault_injection)
        if faults:
            logger.warning(
                "LLM FAULT INJECTION IS ON: model requests fail on purpose; never set this outside local runs",
                extra={"metric": FAULT_INJECTION_METRIC, "faults": settings.llm_fault_injection},
            )
        orchestrator = build_model_chain(
            ORCHESTRATOR,
            [settings.bot_model, *parse_model_list(settings.bot_model_fallbacks)],
            settings=ModelSettings(
                first_event_timeout=settings.llm_first_event_timeout_seconds,
                request_timeout=settings.llm_request_timeout_seconds,
            ),
            breakers=breakers,
            faults=faults,
        )
        guard = build_model_chain(
            GUARD,
            [settings.guard_model, *parse_model_list(settings.guard_model_fallbacks)],
            settings=ModelSettings(request_timeout=settings.guard_request_timeout_seconds),
            breakers=breakers,
            faults=faults,
        )
        return cls(orchestrator=orchestrator, guard=guard)
