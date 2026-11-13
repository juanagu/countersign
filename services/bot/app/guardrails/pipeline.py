"""The guardrails a run gets: the input classifier and the write-intent check, bound to GUARD_MODEL."""

from collections.abc import Sequence
from dataclasses import dataclass, field

from pydantic_ai.models import Model

from app.core.clock import BankClock
from app.guardrails.input_classifier import GuardModelClassifier, InputClassifier
from app.guardrails.run_guard import RunGuard, WriteIntentCheck
from app.guardrails.write_intent import GuardModelWriteIntent


@dataclass(frozen=True)
class Guardrails:
    classifier: InputClassifier
    write_intent: WriteIntentCheck
    clock: BankClock = field(default_factory=BankClock)  # Grounding accepts the bank's today, not the host's.

    @classmethod
    def on_model(cls, model: Model | str, *, clock: BankClock | None = None) -> "Guardrails":
        return cls(
            classifier=GuardModelClassifier(model),
            write_intent=GuardModelWriteIntent(model),
            clock=clock or BankClock(),
        )

    def start_run(self, *, user_id: str, customer_messages: Sequence[str], third_party_text_seen: bool) -> RunGuard:
        """A run guard whose input verdict is being computed in the background from now on."""
        guard = RunGuard(
            customer_messages=list(customer_messages),
            today=self.clock.today(),
            write_intent=self.write_intent,
            third_party_text_seen=third_party_text_seen,
        )
        guard.classify_with(self.classifier(guard.latest_message, user_id))
        return guard
