"""The eval hook reads a subagent's calls from the run's spans and their arguments from the cards."""

from decimal import Decimal
from typing import Any

from evals.calls import ObservedCall
from evals.delegation import delegated_calls

CONFIRM = {
    "template": "transfer-confirm",
    "data": {"beneficiaryId": "ben-ana-juan", "amount": "10000.00", "currency": "ARS"},
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
        _span("prep", "ask", "prepare_transfer", "2"),
        transport,
    ]

    calls = delegated_calls(spans, [])

    assert [(c.name, c.outcome) for c in calls] == [
        ("ask_payments", "result"),
        ("prepare_transfer", "error:insufficient_funds"),
    ]
