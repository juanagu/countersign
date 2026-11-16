"""The eval hook for subagent domains. Only a subagent's tool names reach the client, so a case reads its calls from
the run's Phoenix spans by trace id: the handoff (the delegate tool's span) and the tool spans under it. Spans carry
no arguments or results (rule 7), so a `prepare_transfer`'s arguments are read from the confirm card its own success
made: within one run, the n-th successful prepare, in start order, owns the n-th distinct confirm card the run showed
(a failed one has none). A refused call is told by the flag the bot sets on its span (`policy.denied`)."""

import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from typing import Any

from app.guardrails.stream_timing import RUN_ID_ATTRIBUTE, THREAD_ATTRIBUTE
from app.policy.policy_toolset import POLICY_DENIED_ATTRIBUTE
from app.subagents.registry import DELEGATE_PREFIX
from evals.agui_client import RunTrace
from evals.calls import ERROR_PREFIX, POLICY_DENIED, RESULT, ObservedCall, parse_error, retry_after
from evals.metrics import STREAM_SPAN, Span, spans

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


def delegated_calls(trace_spans: Sequence[Span], cards: Mapping[str, Sequence[dict[str, Any]]]) -> list[ObservedCall]:
    """Each handoff and each tool call made under one, in start order, with the outcome its span recorded. `cards`
    maps a trace id to the confirm cards of the run that trace is."""
    by_id = {span["context"]["span_id"]: span for span in trace_spans}
    handoffs = {sid for sid, span in by_id.items() if str(_tool(span) or "").startswith(DELEGATE_PREFIX)}

    def under_handoff(span: Span) -> bool:
        parent = span.get("parent_id")
        while parent in by_id:
            if parent in handoffs:
                return True
            parent = by_id[parent].get("parent_id")
        return False

    confirms = {trace_id: iter(run_cards) for trace_id, run_cards in cards.items()}
    calls: list[ObservedCall] = []
    for span in sorted(trace_spans, key=lambda s: str(s.get("start_time"))):
        name = _tool(span)
        if not name or (span.get("attributes") or {}).get(MCP_METHOD):
            continue
        is_handoff = span["context"]["span_id"] in handoffs
        if not is_handoff and not under_handoff(span):
            continue
        outcome, retry = _outcome(span, trace_spans, is_handoff=is_handoff)
        data = None
        if name == PREPARE_TOOL and outcome == RESULT:
            data = next(confirms.get(span["context"]["trace_id"], iter(())), None)
        args = card_args(data) if data else {}
        calls.append(ObservedCall(name, args, outcome, delegated=True, retry_after_seconds=retry))
    return calls


@dataclass(frozen=True)
class PairedCards:
    """The confirm cards per trace id, and how many arrived traces no run could be matched to."""

    cards: dict[str, list[dict[str, Any]]]
    unpaired: int = 0


def cards_by_trace(streams: Sequence[Span], runs: Sequence[RunTrace]) -> PairedCards:
    """The confirm cards of the run each arrived trace belongs to, matched by the run id its `bot.stream` span
    carries. A trace with no id, or one no run has (a BFF `restore-...` RUN_STARTED, say), is counted, never guessed
    by order: a wrong pairing would give a prepare another run's arguments."""
    shown = _cards_per_run(runs)
    by_run_id = {run.run_id: run_cards for run, run_cards in zip(runs, shown, strict=True) if run.run_id}
    cards: dict[str, list[dict[str, Any]]] = {}
    for stream in streams:
        run_id = (stream.get("attributes") or {}).get(RUN_ID_ATTRIBUTE)
        if run_id in by_run_id:
            cards[stream["context"]["trace_id"]] = by_run_id[run_id]
    return PairedCards(cards, len(streams) - len(cards))


def _cards_per_run(runs: Sequence[RunTrace]) -> list[list[dict[str, Any]]]:
    """Each run's new confirm cards' data: a draft belongs to the first run that showed it."""
    seen: set[str] = set()
    per_run: list[list[dict[str, Any]]] = []
    for run in runs:
        fresh = [data for data in confirm_cards(run.cards) if str(data["draftId"]) not in seen]
        seen |= {str(data["draftId"]) for data in fresh}
        per_run.append(fresh)
    return per_run


def _outcome(call: Span, trace_spans: Sequence[Span], *, is_handoff: bool) -> tuple[str, int | None]:
    """The call's own span decides: `policy_denied` when the bot flagged it (a denial is a normal result, so the span
    ends OK), `result` unless it ended in ERROR. Then `error:<code>` (and the gateway's
    `retry_after_seconds`), the code read from the span's message or, when it has none, from the ERROR spans below it
    (the MCP transport's). An ERROR in a descendant of a successful call changes nothing. A handoff reads only its own
    span: an inner tool's failure is that tool's, not the handoff's."""
    if (call.get("attributes") or {}).get(POLICY_DENIED_ATTRIBUTE):
        return POLICY_DENIED, None
    if call.get("status_code") != "ERROR":
        return RESULT, None
    if is_handoff:
        return _own_error(call)
    family = {call["context"]["span_id"]}
    for span in sorted(trace_spans, key=lambda s: str(s.get("start_time"))):
        if span.get("parent_id") in family:
            family.add(span["context"]["span_id"])
    failed = [call, *(s for s in trace_spans if s["context"]["span_id"] in family and s.get("status_code") == "ERROR")]
    errors = [e for span in failed if (e := parse_error(str(span.get("status_message") or "")))]
    if not errors:
        return f"{ERROR_PREFIX}{UNKNOWN_ERROR}", None
    return f"{ERROR_PREFIX}{errors[0]['error']}", retry_after(errors[0])


def _own_error(call: Span) -> tuple[str, int | None]:
    error = parse_error(str(call.get("status_message") or ""))
    if not error:
        return f"{ERROR_PREFIX}{UNKNOWN_ERROR}", None
    return f"{ERROR_PREFIX}{error['error']}", retry_after(error)


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


async def read_delegated(thread_id: str, since: datetime, runs: Sequence[RunTrace]) -> Delegated:
    """The thread's delegated calls since `since`: from all of its `runs` once they reached Phoenix (a span is
    exported at its run's end, children first), else from the traces that did arrive when the waits ran out, with a
    note naming how many are missing."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + EXPORT_WAIT_SECONDS + LATE_EXPORT_WAIT_SECONDS
    while True:
        every_stream = await asyncio.to_thread(lambda: list(spans(since, name=STREAM_SPAN)))
        streams = [s for s in every_stream if (s.get("attributes") or {}).get(THREAD_ATTRIBUTE) == thread_id]
        traces = {s["context"]["trace_id"] for s in streams}
        if len(traces) >= len(runs) or loop.time() > deadline:
            break
        await asyncio.sleep(POLL_SECONDS)
    every = await asyncio.to_thread(lambda: list(spans(since))) if traces else []
    paired = cards_by_trace(streams, runs)
    calls = delegated_calls([s for s in every if s["context"]["trace_id"] in traces], paired.cards)
    gaps = []
    if len(traces) < len(runs):
        gaps.append(f"only {len(traces)} of {len(runs)} runs reached Phoenix for the thread")
    if paired.unpaired:
        gaps.append(f"{paired.unpaired} traces could not be paired with a run, so their cards are unread")
    return Delegated(calls, "; ".join(gaps))
