"""The calls a run made, in order, with the outcome of each: what a CUJ's trajectory is checked against.

Client calls come from the AG-UI stream. A subagent's inner calls never reach it (ADR 021), so they come from
Phoenix spans (`evals/delegation.py`) and are placed after the handoff that made them.
"""

import json
from collections.abc import Collection, Sequence
from dataclasses import dataclass, field
from typing import Any

from app.subagents.registry import DELEGATE_PREFIX
from evals.agui_client import RunTrace

RESULT = "result"
PAUSED = "paused"  # The call raised an approval interrupt and nothing has answered it yet (ADR 013).
CANCELLED = "cancelled"  # The customer answered the interrupt with a refusal.
UNFINISHED = "unfinished"
ANY = "any"  # Only in an expected step: matches every outcome.
ERROR_PREFIX = "error:"


@dataclass(frozen=True)
class ObservedCall:
    name: str
    args: dict[str, Any] = field(default_factory=dict)
    outcome: str = RESULT
    delegated: bool = False  # Read from a span, not from the client's stream.

    @property
    def is_handoff(self) -> bool:
        return self.name.startswith(DELEGATE_PREFIX)


def result_outcome(content: str) -> str:
    """`result`, or `error:<code>` when the tool reported one (as `{"error": code, ...}`, wrapped or not)."""
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return RESULT
    inner = parsed.get("untrusted_data", parsed) if isinstance(parsed, dict) else None
    if isinstance(inner, dict) and isinstance(inner.get("error"), str):
        return f"{ERROR_PREFIX}{inner['error']}"
    return RESULT


def client_calls(traces: Sequence[RunTrace], cancelled: Collection[str] = ()) -> list[ObservedCall]:
    """Calls the client saw across a thread's runs. A call that paused and was later answered appears twice:
    `paused` in the run that raised it, then its outcome in the run that resumed it (which has no start event)."""
    known: dict[str, tuple[str, dict[str, Any]]] = {}
    calls: list[ObservedCall] = []
    for trace in traces:
        paused = {i["toolCallId"] for i in trace.interrupts}
        resulted = {e["toolCallId"] for e in trace.of("TOOL_CALL_RESULT")}
        starts = trace.of("TOOL_CALL_START")
        known |= {s["toolCallId"]: (name, args) for s, (name, args) in zip(starts, trace.tool_args, strict=True)}
        for event in trace.events:
            call_id = str(event.get("toolCallId"))
            if event.get("type") == "TOOL_CALL_START":
                if call_id in paused:
                    calls.append(ObservedCall(*known[call_id], outcome=PAUSED))
                elif call_id not in resulted:
                    calls.append(ObservedCall(*known[call_id], outcome=UNFINISHED))
            elif event.get("type") == "TOOL_CALL_RESULT" and call_id in known:
                outcome = CANCELLED if call_id in cancelled else result_outcome(str(event.get("content", "")))
                calls.append(ObservedCall(*known[call_id], outcome=outcome))
    return calls


def with_delegated(client: Sequence[ObservedCall], delegated: Sequence[ObservedCall]) -> list[ObservedCall]:
    """Places each handoff's inner calls right after the client's matching `ask_<name>` call, in order."""
    groups: list[list[ObservedCall]] = []
    for call in delegated:
        if call.is_handoff:
            groups.append([])
        elif groups:
            groups[-1].append(call)
    merged: list[ObservedCall] = []
    handoffs = iter(groups)
    for call in client:
        merged.append(call)
        if call.is_handoff:
            merged.extend(next(handoffs, []))
    return merged
