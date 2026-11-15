"""The eval hook for subagent domains. Only a subagent's tool names reach the client, so a case reads its calls from
the run's Phoenix spans by trace id: the handoff (the delegate tool's span) and the tool spans under it. Spans carry
no arguments (rule 7), so the arguments are read from the server cards the calls produced."""

import asyncio
import json
from collections.abc import Sequence
from datetime import datetime
from decimal import Decimal
from typing import Any

from app.guardrails.stream_timing import THREAD_ATTRIBUTE
from app.subagents.registry import DELEGATE_PREFIX
from evals.calls import ERROR_PREFIX, RESULT, ObservedCall
from evals.metrics import Span, spans

TOOL_NAME = "gen_ai.tool.name"
MCP_METHOD = "mcp.method.name"  # Set on the MCP transport's own span, which repeats the tool's `execute_tool` span.
EXPORT_WAIT_SECONDS = 30.0  # The bot's BatchSpanProcessor exports every few seconds.
POLL_SECONDS = 2.0


def card_args(tool: str, cards: Sequence[dict[str, Any]]) -> dict[str, Any]:
    """The arguments a call carried, as its server card shows them; only `prepare_transfer` has a card."""
    if tool != "prepare_transfer":
        return {}
    confirms = [c["data"] for c in cards if c.get("template") == "transfer-confirm"]
    if not confirms:
        return {}
    data = confirms[-1]
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

    calls: list[ObservedCall] = []
    for span in sorted(trace_spans, key=lambda s: str(s.get("start_time"))):
        name = _tool(span)
        if not name or (span.get("attributes") or {}).get(MCP_METHOD):
            continue
        if span["context"]["span_id"] in handoffs:
            calls.append(ObservedCall(name, outcome=RESULT, delegated=True))
        elif under_handoff(span):
            outcome = _outcome(span, trace_spans)
            calls.append(ObservedCall(name, card_args(name, cards), outcome, delegated=True))
    return calls


def _outcome(call: Span, trace_spans: Sequence[Span]) -> str:
    """`error:<code>` when the call's span or one of its descendants ended in an error carrying a code."""
    family = {call["context"]["span_id"]}
    for span in sorted(trace_spans, key=lambda s: str(s.get("start_time"))):
        if span.get("parent_id") in family:
            family.add(span["context"]["span_id"])
    for span in trace_spans:
        if span["context"]["span_id"] in family and span.get("status_code") == "ERROR":
            return f"{ERROR_PREFIX}{_error_code(str(span.get('status_message') or ''))}"
    return RESULT


def _error_code(message: str) -> str:
    try:
        parsed = json.loads(message)
    except json.JSONDecodeError:
        return "unknown"
    code = parsed.get("error") if isinstance(parsed, dict) else None
    return code if isinstance(code, str) else "unknown"


def _thread(span: Span) -> object:
    return (span.get("attributes") or {}).get(THREAD_ATTRIBUTE)


def _tool(span: Span) -> str | None:
    value = (span.get("attributes") or {}).get(TOOL_NAME)
    return value if isinstance(value, str) else None


async def read_delegated(thread_id: str, since: datetime, cards: Sequence[dict[str, Any]]) -> list[ObservedCall] | None:
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
