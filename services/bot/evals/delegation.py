"""The eval hook for subagent domains (ADR 021 §6). A subagent's tool calls never reach the client, so a case reads
them from its run's Phoenix spans by trace id: the handoff (the `ask_<name>` span) and the tool spans under it. Spans
carry no arguments (rule 7), so the arguments are read from the server cards the calls produced."""

import asyncio
from collections.abc import Sequence
from datetime import datetime
from decimal import Decimal
from typing import Any

from evals.metrics import Span, spans

THREAD_ATTRIBUTE = "bot.thread_id"  # On the `bot.stream` span, which shares the run's trace (stream_timing.py).
TOOL_NAME = "gen_ai.tool.name"
DELEGATE_PREFIX = "ask_"
EXPORT_WAIT_SECONDS = 30.0  # The bot's BatchSpanProcessor exports every few seconds.
POLL_SECONDS = 2.0

Call = tuple[str, dict[str, Any]]


def card_args(tool: str, cards: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """The arguments a call carried, as its server card shows them; only `prepare_transfer` has a card."""
    if tool != "prepare_transfer":
        return {}
    confirms = [c["data"] for c in cards if c.get("template") == "transfer-confirm"]
    if not confirms:
        return {}
    data = confirms[-1]
    return {"beneficiary_id": data["beneficiaryId"], "amount": Decimal(data["amount"]), "currency": data["currency"]}


def delegated_calls(trace_spans: Sequence[Span], cards: Sequence[dict[str, Any]]) -> list[Call]:
    """Each handoff and each tool call made under one, in start order."""
    by_id = {span["context"]["span_id"]: span for span in trace_spans}
    handoffs = {sid for sid, span in by_id.items() if str(_tool(span) or "").startswith(DELEGATE_PREFIX)}

    def under_handoff(span: Span) -> bool:
        parent = span.get("parent_id")
        while parent in by_id:
            if parent in handoffs:
                return True
            parent = by_id[parent].get("parent_id")
        return False

    calls: list[Call] = []
    for span in sorted(trace_spans, key=lambda s: str(s.get("start_time"))):
        name = _tool(span)
        if name and span["context"]["span_id"] in handoffs:
            calls.append((name, {}))
        elif name and under_handoff(span):
            calls.append((name, card_args(name, cards)))
    return calls


def _thread(span: Span) -> object:
    return (span.get("attributes") or {}).get(THREAD_ATTRIBUTE)


def _tool(span: Span) -> str | None:
    value = (span.get("attributes") or {}).get(TOOL_NAME)
    return value if isinstance(value, str) else None


async def read_delegated(thread_id: str, since: datetime, cards: Sequence[dict[str, Any]]) -> list[Call] | None:
    """The thread's delegated calls since `since`, or None when its spans never reached Phoenix."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + EXPORT_WAIT_SECONDS
    while True:
        streams = await asyncio.to_thread(lambda: list(spans(since, name="bot.stream")))
        traces = {
            s["context"]["trace_id"] for s in streams if (s.get("attributes") or {}).get(THREAD_ATTRIBUTE) == thread_id
        }
        if traces:
            every = await asyncio.to_thread(lambda: list(spans(since)))
            return delegated_calls([s for s in every if s["context"]["trace_id"] in traces], cards)
        if loop.time() > deadline:
            return None
        await asyncio.sleep(POLL_SECONDS)
