"""The eval hook for subagent domains. Only a subagent's tool names reach the client, so a case reads its calls from
the run's Phoenix spans by trace id: the handoff (the delegate tool's span) and the tool spans under it. Spans carry
no arguments or results (rule 7), so a `prepare_transfer`'s arguments are read from the confirm card its own success
made: the n-th successful prepare, in start order, owns the n-th distinct confirm card (a failed one has none)."""

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from app.guardrails.stream_timing import THREAD_ATTRIBUTE
from app.subagents.registry import DELEGATE_PREFIX
from evals.calls import ERROR_PREFIX, RESULT, ObservedCall, parse_error, retry_after
from evals.metrics import Span, spans

TOOL_NAME = "gen_ai.tool.name"
MCP_METHOD = "mcp.method.name"  # Set on the MCP transport's own span, which repeats the tool's `execute_tool` span.
EXPORT_WAIT_SECONDS = 30.0  # The bot's BatchSpanProcessor exports every few seconds.
LATE_EXPORT_WAIT_SECONDS = 60.0  # One longer final wait before a missing run is called missing: it may only be late.
POLL_SECONDS = 2.0
UNKNOWN_ERROR = "unknown"
CONFIRM_TEMPLATE = "transfer-confirm"
PREPARE_TOOL = "prepare_transfer"


def confirm_cards(cards: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    """The distinct confirm cards' data, in the order they were shown."""
    seen: dict[str, dict[str, Any]] = {}
    for card in cards:
        if card.get("template") == CONFIRM_TEMPLATE:
            seen.setdefault(str(card["data"]["draftId"]), card["data"])
    return list(seen.values())


def card_args(data: dict[str, Any]) -> dict[str, Any]:
    return {"beneficiary_id": data["beneficiaryId"], "amount": Decimal(data["amount"]), "currency": data["currency"]}


def delegated_calls(trace_spans: Sequence[Span], cards: Sequence[dict[str, Any]]) -> list[ObservedCall]:
    """Each handoff and each tool call made under one, in start order, with the outcome its span recorded."""
    by_id = {span["context"]["span_id"]: span for span in trace_spans}
    handoffs = {sid for sid, span in by_id.items() if str(_tool(span) or "").startswith(DELEGATE_PREFIX)}

    def under_handoff(span: Span) -> bool:
        parent = span.get("parent_id")
        while parent in by_id:
            if parent in handoffs:
                return True
            parent = by_id[parent].get("parent_id")
        return False

    confirms = iter(confirm_cards(cards))
    calls: list[ObservedCall] = []
    for span in sorted(trace_spans, key=lambda s: str(s.get("start_time"))):
        name = _tool(span)
        if not name or (span.get("attributes") or {}).get(MCP_METHOD):
            continue
        if span["context"]["span_id"] in handoffs:
            calls.append(ObservedCall(name, outcome=RESULT, delegated=True))
        elif under_handoff(span):
            outcome, retry = _outcome(span, trace_spans)
            data = next(confirms, None) if name == PREPARE_TOOL and outcome == RESULT else None
            args = card_args(data) if data else {}
            calls.append(ObservedCall(name, args, outcome, delegated=True, retry_after_seconds=retry))
    return calls


def _outcome(call: Span, trace_spans: Sequence[Span]) -> tuple[str, int | None]:
    """The call's own span decides: `result` unless it ended in ERROR. Then `error:<code>` (and the gateway's
    `retry_after_seconds`), the code read from the span's message or, when it has none, from the ERROR spans below it
    (the MCP transport's). An ERROR in a descendant of a successful call changes nothing."""
    if call.get("status_code") != "ERROR":
        return RESULT, None
    family = {call["context"]["span_id"]}
    for span in sorted(trace_spans, key=lambda s: str(s.get("start_time"))):
        if span.get("parent_id") in family:
            family.add(span["context"]["span_id"])
    failed = [call, *(s for s in trace_spans if s["context"]["span_id"] in family and s.get("status_code") == "ERROR")]
    errors = [e for span in failed if (e := parse_error(str(span.get("status_message") or "")))]
    if not errors:
        return f"{ERROR_PREFIX}{UNKNOWN_ERROR}", None
    return f"{ERROR_PREFIX}{errors[0]['error']}", retry_after(errors[0])


def _thread(span: Span) -> object:
    return (span.get("attributes") or {}).get(THREAD_ATTRIBUTE)


def _tool(span: Span) -> str | None:
    value = (span.get("attributes") or {}).get(TOOL_NAME)
    return value if isinstance(value, str) else None


@dataclass(frozen=True)
class Delegated:
    """The delegated calls of the runs that reached Phoenix, and a note when some run did not."""

    calls: list[ObservedCall]
    note: str = ""


async def read_delegated(thread_id: str, since: datetime, cards: Sequence[dict[str, Any]], runs: int) -> Delegated:
    """The thread's delegated calls since `since`: from all of its `runs` runs once they reached Phoenix (a span is
    exported at its run's end, children first), else from the traces that did arrive when the waits ran out, with a
    note naming how many are missing."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + EXPORT_WAIT_SECONDS + LATE_EXPORT_WAIT_SECONDS
    while True:
        streams = await asyncio.to_thread(lambda: list(spans(since, name="bot.stream")))
        traces = {
            s["context"]["trace_id"] for s in streams if (s.get("attributes") or {}).get(THREAD_ATTRIBUTE) == thread_id
        }
        if len(traces) >= runs or loop.time() > deadline:
            break
        await asyncio.sleep(POLL_SECONDS)
    every = await asyncio.to_thread(lambda: list(spans(since))) if traces else []
    calls = delegated_calls([s for s in every if s["context"]["trace_id"] in traces], cards)
    note = f"only {len(traces)} of {runs} runs reached Phoenix for the thread" if len(traces) < runs else ""
    return Delegated(calls, note)
