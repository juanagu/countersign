"""Per-run guardrail state shared by the tool policy (inside the agent run) and the output stream (outside it)."""

import asyncio
import logging
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.core.clock import BankClock
from app.guardrails.grounding import Evidence
from app.guardrails.verdict import Verdict, block

logger = logging.getLogger(__name__)

INPUT_CHECK_FAILED_METRIC = "guardrail.input.check_failed"
UNCHECKED_REASON = "the input was not classified"


# Does the customer's own message ask for this exact write (messages, tool, args)? Allow, or block with a reason.
WriteIntentCheck = Callable[[Sequence[str], str, Mapping[str, Any]], Awaitable[Verdict]]


async def deny_writes(_: Sequence[str], __: str, ___: Mapping[str, Any]) -> Verdict:
    return block("no write-intent check is configured")


@dataclass
class RunGuard:
    """One per run. The input verdict is a gate: tools above T0 and all text wait for it (fail closed).

    A guard that nobody classifies stays blocked, so a run built without the input pipeline (a script, a
    test that forgets it) can still use T0 tools but nothing personal.
    """

    customer_messages: list[str] = field(default_factory=list)  # Redacted, oldest first.
    today: date = field(default_factory=lambda: BankClock().today())
    write_intent: WriteIntentCheck = deny_writes
    # Set once the run (or its history) holds third-party free text: memos, merchant names, KB passages.
    third_party_text_seen: bool = False
    evidence: Evidence = field(default_factory=Evidence)
    # Ids of the status calls code opened around a delegation (`subagents.progress`): the only delegate-named calls
    # the output guard lets out, as they carry no arguments and an empty result.
    status_calls: set[str] = field(default_factory=set)
    _verdict: Verdict | None = None
    _decided: asyncio.Event = field(default_factory=asyncio.Event)
    _task: asyncio.Task[None] | None = None

    def __post_init__(self) -> None:
        self.evidence.add_date(self.today)
        if self.customer_messages:
            # The customer's own figures may be echoed back ("¿Le mando $ 50.000 a Ana?") before any tool runs.
            self.evidence.add_text(self.customer_messages[-1])

    @classmethod
    def unchecked(cls) -> "RunGuard":
        guard = cls()
        guard.decide(block(UNCHECKED_REASON, category="unchecked"))
        return guard

    @property
    def latest_message(self) -> str:
        return self.customer_messages[-1] if self.customer_messages else ""

    @property
    def verdict(self) -> Verdict | None:
        return self._verdict

    def decide(self, verdict: Verdict) -> None:
        if self._verdict is None:
            self._verdict = verdict
            self._decided.set()

    async def input_verdict(self) -> Verdict:
        await self._decided.wait()
        assert self._verdict is not None  # noqa: S101 (set together with the event)
        return self._verdict

    def classify_with(self, check: Awaitable[Verdict]) -> None:
        """Runs the input check in the background; its verdict opens or closes the gate."""

        async def run() -> None:
            try:
                self.decide(await check)
            except Exception:  # A failing check must close the gate, never leave it waiting.
                logger.warning("input check failed", exc_info=True, extra={"metric": INPUT_CHECK_FAILED_METRIC})
                self.decide(block("the input check failed", category="error"))

        self._task = asyncio.create_task(run())

    def cancel(self) -> None:
        if self._task is not None and not self._task.done():
            self._task.cancel()
        self.decide(block("the run ended before the input was classified", category="unchecked"))

    def record_tool_result(self, value: Any, *, third_party_text: bool) -> None:
        self.evidence.add(value)
        self.third_party_text_seen = self.third_party_text_seen or third_party_text
