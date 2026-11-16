"""The eval hook reads a subagent's calls from the run's spans and their arguments from the cards."""

from decimal import Decimal
from typing import Any

import pytest

from evals import delegation
from evals.calls import ObservedCall
from evals.delegation import delegated_calls

CONFIRM = {
    "template": "transfer-confirm",
    "data": {"draftId": "drf_1", "beneficiaryId": "ben-ana-juan", "amount": "10000.00", "currency": "ARS"},
}


def _span(
    span_id: str, parent: str | None, tool: str | None, start: str, *, status: str = "UNSET", message: str = ""
) -> dict[str, Any]:
    attributes = {"gen_ai.tool.name": tool} if tool else {}
    return {
        "context": {"span_id": span_id, "trace_id": "t"},
        "parent_id": parent,
        "attributes": attributes,
        "start_time": start,
        "status_code": status,
        "status_message": message,
    }


def test_reads_the_handoff_and_the_subagents_calls_under_it_with_arguments_from_the_card() -> None:
    spans = [
        _span("root", None, None, "1"),
        _span("load", "root", "load_skill", "2"),
        _span("ask", "root", "ask_payments", "3"),
        _span("sub-run", "ask", None, "4"),
        _span("prep", "sub-run", "prepare_transfer", "6"),
        _span("list", "sub-run", "list_beneficiaries", "5"),
        _span("exec", "root", "execute_transfer", "7"),
    ]
    prepared = {"beneficiary_id": "ben-ana-juan", "amount": Decimal("10000.00"), "currency": "ARS"}
    assert delegated_calls(spans, [CONFIRM]) == [
        ObservedCall("ask_payments", delegated=True),
        ObservedCall("list_beneficiaries", delegated=True),
        ObservedCall("prepare_transfer", prepared, delegated=True),
    ]


def test_without_a_handoff_nothing_is_delegated() -> None:
    assert delegated_calls([_span("a", None, "prepare_transfer", "1")], [CONFIRM]) == []


def test_the_mcp_transport_span_does_not_count_as_a_second_call_and_carries_the_error() -> None:
    transport = _span("rpc", "prep", "prepare_transfer", "7", status="ERROR", message='{"error":"insufficient_funds"}')
    transport["attributes"]["mcp.method.name"] = "tools/call"
    spans = [
        _span("ask", None, "ask_payments", "1"),
        _span("prep", "ask", "prepare_transfer", "2", status="ERROR"),
        transport,
    ]

    calls = delegated_calls(spans, [])

    assert [(c.name, c.outcome) for c in calls] == [
        ("ask_payments", "result"),
        ("prepare_transfer", "error:insufficient_funds"),
    ]


def test_the_error_code_comes_from_the_transport_span_when_the_tool_span_has_no_message() -> None:
    transport = _span("rpc", "prep", "prepare_transfer", "3", status="ERROR", message='{"error":"insufficient_funds"}')
    transport["attributes"]["mcp.method.name"] = "tools/call"
    spans = [
        _span("ask", None, "ask_payments", "1"),
        _span("prep", "ask", "prepare_transfer", "2", status="ERROR"),  # Ends in ERROR, says nothing more.
        transport,
    ]

    assert [c.outcome for c in delegated_calls(spans, [])] == ["result", "error:insufficient_funds"]


def _confirm(draft: str, amount: str) -> dict[str, Any]:
    data = {"draftId": draft, "beneficiaryId": "ben-ana-juan", "amount": amount, "currency": "ARS"}
    return {"template": "transfer-confirm", "data": data}


def test_each_prepare_keeps_its_own_cards_arguments_and_a_failed_one_has_none() -> None:
    failed = _span("p2", "ask", "prepare_transfer", "3", status="ERROR", message='{"error":"insufficient_funds"}')
    spans = [
        _span("ask", None, "ask_payments", "1"),
        _span("p1", "ask", "prepare_transfer", "2"),
        failed,
        _span("p3", "ask", "prepare_transfer", "4"),
    ]
    cards = [_confirm("drf_1", "10000.00"), _confirm("drf_1", "10000.00"), _confirm("drf_2", "25000.00")]

    prepares = [c for c in delegated_calls(spans, cards) if c.name == "prepare_transfer"]

    assert [c.args.get("amount") for c in prepares] == [Decimal("10000.00"), None, Decimal("25000.00")]


def test_the_gateways_retry_after_is_read_from_the_error() -> None:
    message = '{"error":"rate_limited","retry_after_seconds":37}'
    spans = [
        _span("ask", None, "ask_payments", "1"),
        _span("p", "ask", "prepare_transfer", "2", status="ERROR", message=message),
    ]

    [_, prepare] = delegated_calls(spans, [])

    assert (prepare.outcome, prepare.retry_after_seconds) == ("error:rate_limited", 37)


def test_an_error_in_a_child_span_does_not_fail_a_call_that_succeeded() -> None:
    child = _span("rpc", "prep", "prepare_transfer", "3", status="ERROR", message='{"error":"insufficient_funds"}')
    child["attributes"]["mcp.method.name"] = "tools/call"
    spans = [_span("ask", None, "ask_payments", "1"), _span("prep", "ask", "prepare_transfer", "2", status="OK"), child]

    [_, prepare] = delegated_calls(spans, [CONFIRM])

    assert prepare.outcome == "result"
    assert prepare.args["amount"] == Decimal("10000.00")  # It keeps its card.


async def test_the_runs_that_reached_phoenix_are_read_and_the_missing_one_is_noted(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    stream = {"context": {"trace_id": "t"}, "attributes": {delegation.THREAD_ATTRIBUTE: "thr"}}
    handoff = _span("ask", None, "ask_payments", "1")

    def fake_spans(_since: object, **filters: object) -> list[dict[str, Any]]:
        return [stream] if filters.get("name") == "bot.stream" else [handoff]

    monkeypatch.setattr(delegation, "spans", fake_spans)
    monkeypatch.setattr(delegation, "EXPORT_WAIT_SECONDS", 0.0)

    from datetime import UTC, datetime

    result = await delegation.read_delegated("thr", datetime.now(UTC), [], runs=2)

    assert [c.name for c in result.calls] == ["ask_payments"]
    assert "1 of 2 runs" in result.note
