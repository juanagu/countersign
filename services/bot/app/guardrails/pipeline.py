"""The guardrails a run gets: the input classifier and the write-intent check, bound to GUARD_MODEL."""

from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any

from pydantic_ai.models import Model

from app.core.clock import BankClock
from app.guardrails.input_classifier import GuardModelClassifier, InputClassifier
from app.guardrails.run_guard import RunGuard, WriteIntentCheck
from app.guardrails.verdict import Action, Verdict
from app.guardrails.write_intent import GuardModelWriteIntent

# The run that raised the interrupt classified this message; re-classifying could waste the step-up token.
RESUMED = Verdict(Action.ALLOW, "an approval resume with no new customer message", category="resumed")


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

    def start_run(
        self,
        *,
        user_id: str,
        customer_messages: Sequence[str],
        third_party_text_seen: bool,
        earlier_tool_results: Sequence[Any] = (),
        resume_only: bool = False,
    ) -> RunGuard:
        """A run guard whose input verdict is being computed in the background from now on.

        Tool results from earlier turns ground figures too, so a follow-up may restate them. The history is the
        client's: a forged result only lets the customer ground claims shown to themselves (ADR 014).
        A `resume_only` run (an approval resume, no new customer message) opens the gate without the classifier.
        """
        guard = RunGuard(
            customer_messages=list(customer_messages),
            today=self.clock.today(),
            write_intent=self.write_intent,
            third_party_text_seen=third_party_text_seen,
        )
        for value in earlier_tool_results:
            guard.evidence.add(value)
        if resume_only:
            guard.decide(RESUMED)
        else:
            guard.classify_with(self.classifier(guard.latest_message, user_id))
        return guard
