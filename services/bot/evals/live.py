"""The live eval task: one case runs through the BFF like a browser session, and comes back as `LiveOutput`.

Three flows: `chat` (turns), `transfer` (Scenario 3: confirm card, interrupt, step-up, resume, receipt, with the
ledger read before and after) and `resume` (Scenario 5: the stream is cut mid-answer, then the thread is
reconnected twice).
"""

import json
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

from pydantic import BaseModel

from evals.agui_client import BffSession, Event, RunTrace, bff_client
from evals.bank_db import Ledger, read_ledger
from evals.calls import ObservedCall, client_calls, with_delegated
from evals.delegation import read_delegated

STEP_UP_PIN = "123456"  # The mock IdP's synthetic PIN (AGENTS.md, rule 3).
KNOWLEDGE_TOOL = "search_knowledge"
Meta = dict[str, str]  # A case's metadata: {"group": <threshold name>}
SPENDING_TOOL = "spending_summary"


class LiveInput(BaseModel):
    user: Literal["ana", "juan"] = "ana"
    turns: list[str]
    flow: Literal["chat", "transfer", "resume"] = "chat"
    source_account: str | None = None  # transfer: the account whose ledger is read before and after
    # A subagent domain: its calls are read from the run's Phoenix spans, since its arguments never reach the client.
    reads_trace: bool = False
    scenario_id: str | None = None  # A CUJ: the runner looks the scenario up by this id.


@dataclass
class ResumeCheck:
    """Scenario 5: what the client had when the connection dropped, and what two reconnects replayed."""

    cut_mid_run: bool
    text_before_cut: str
    replay: RunTrace
    second_replay: RunTrace


@dataclass
class LiveOutput:
    traces: list[RunTrace]
    ledger_change: Ledger | None = None
    resume: ResumeCheck | None = None
    notes: list[str] = field(default_factory=list)
    delegated: list[ObservedCall] = field(default_factory=list)  # From the trace, not the client.
    # A CUJ's extras: the ledger after the journey and each step-up request's HTTP status.
    ledger_after: Ledger | None = None
    step_up_statuses: list[int] = field(default_factory=list)
    thread_id: str = ""
    turns: int = 0
    attempts: int = 1  # A CUJ trial run again because the gateway refused its writes (rate limit).

    @property
    def text(self) -> str:
        return "\n".join(trace.text for trace in self.traces)

    @property
    def shown(self) -> str:
        """Everything the customer read: the text plus every value in the A2UI surfaces."""
        values = [json.dumps(c, ensure_ascii=False) for c in self.components]
        return "\n".join([self.text, *values])

    @property
    def tools(self) -> list[tuple[str, dict[str, Any]]]:
        return [call for trace in self.traces for call in trace.tool_args] + [(c.name, c.args) for c in self.delegated]

    @property
    def calls(self) -> list[ObservedCall]:
        """Every call in order with its outcome, the subagent's included."""
        return with_delegated(
            client_calls(self.traces, frozenset().union(*(t.cancelled for t in self.traces))), self.delegated
        )

    @property
    def handoffs(self) -> set[str]:
        return {c.name for c in self.delegated if c.is_handoff}

    @property
    def components(self) -> list[dict[str, Any]]:
        return [c for trace in self.traces for c in trace.components]

    @property
    def cards(self) -> list[dict[str, Any]]:
        return [c for trace in self.traces for c in trace.cards]

    def results_of(self, tool: str) -> list[str]:
        return [content for trace in self.traces for name, content in trace.tool_results if name == tool]

    @property
    def errors(self) -> list[str]:
        return [error for trace in self.traces for error in trace.errors]

    def for_judge(self) -> dict[str, Any]:
        """What the LLM judge sees: the answer, what it cited and the passages it was given."""
        citations = [c for c in self.components if c.get("component") == "Citation"]
        cards = [c for c in self.components if c.get("component") != "Citation"]
        return {
            "answer_text": self.text,
            "answer_cards": cards,
            "citations": citations,
            "retrieved_passages": self.results_of(KNOWLEDGE_TOOL),
        }

    def __str__(self) -> str:  # The report's output column.
        return json.dumps({"text": self.text[:200], "tools": [n for n, _ in self.tools]}, ensure_ascii=False)


async def _chat(session: BffSession, case: LiveInput) -> LiveOutput:
    return LiveOutput([await session.say(turn) for turn in case.turns])


async def _transfer(session: BffSession, case: LiveInput) -> LiveOutput:
    account = case.source_account or ""
    before = await read_ledger(account)
    first = await session.say(case.turns[0])
    confirm = [c for c in first.cards if c.get("template") == "transfer-confirm"]
    if not (first.interrupts and confirm):
        return LiveOutput([first], notes=["no interrupt or confirm card"])
    token = await session.step_up(confirm[0], STEP_UP_PIN)
    payload = {"approved": True, "editedArgs": {"draft_id": confirm[0]["data"]["draftId"], "step_up_token": token}}
    resumed = await session.resume(first.interrupts[0], payload)
    after = await read_ledger(account)
    return LiveOutput([first, resumed], ledger_change=after.minus(before))


def _first_text(events: list[Event]) -> bool:
    return any(e.get("type") == "TEXT_MESSAGE_CONTENT" for e in events)


async def _resume(session: BffSession, case: LiveInput) -> LiveOutput:
    before = await session.say_until(case.turns[0], _first_text)
    cut_mid_run = bool(before) and before[-1].get("type") != "RUN_FINISHED"
    replay = await session.connect()
    second = await session.connect()
    check = ResumeCheck(cut_mid_run, RunTrace(before).text, replay, second)
    return LiveOutput([replay], resume=check)


FLOWS = {"chat": _chat, "transfer": _transfer, "resume": _resume}


async def run_live(case: LiveInput) -> LiveOutput:
    since = datetime.now(UTC)
    async with bff_client() as http:
        session = await BffSession.login(http, case.user)
        output = await FLOWS[case.flow](session, case)
    if case.reads_trace:
        delegated = await read_delegated(session.thread_id, since, output.cards)
        output.delegated = delegated or []
        output.notes += [] if delegated is not None else ["no trace for the thread in Phoenix"]
    return output
