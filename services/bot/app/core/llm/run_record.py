"""What the model chains did during one chat run: which models answered, which failed, how many failovers.

Set by `chat/routes.py` before the guard and the run start, so every task they create sees the same record.
"""

from contextvars import ContextVar
from dataclasses import dataclass, field

from opentelemetry.util.types import AttributeValue

MODELS_SERVED_ATTRIBUTE = "bot.models_served"
FAILOVERS_ATTRIBUTE = "bot.failovers"


@dataclass
class RunRecord:
    served: set[str] = field(default_factory=set)  # "role:model" entries
    failed_models: set[str] = field(default_factory=set)
    failovers: int = 0

    def record_served(self, role: str, model_name: str) -> None:
        self.served.add(f"{role}:{model_name}")

    def record_failover(self, model_name: str) -> None:
        self.failed_models.add(model_name)
        self.failovers += 1

    def span_attributes(self) -> dict[str, AttributeValue]:
        return {MODELS_SERVED_ATTRIBUTE: sorted(self.served), FAILOVERS_ATTRIBUTE: self.failovers}


_current: ContextVar[RunRecord | None] = ContextVar("llm_run_record", default=None)


def start_run_record() -> RunRecord:
    """A fresh record for the current request's context and the tasks it starts from now on."""
    record = RunRecord()
    _current.set(record)
    return record


def current_run_record() -> RunRecord | None:
    return _current.get()
