"""The eval hook reads a subagent's calls from the run's spans and their arguments from the cards."""

from decimal import Decimal
from typing import Any

from evals.delegation import delegated_calls

CONFIRM = {
    "template": "transfer-confirm",
    "data": {"beneficiaryId": "ben-ana-juan", "amount": "10000.00", "currency": "ARS"},
}


def _span(span_id: str, parent: str | None, tool: str | None, start: str) -> dict[str, Any]:
    attributes = {"gen_ai.tool.name": tool} if tool else {}
    return {
        "context": {"span_id": span_id, "trace_id": "t"},
        "parent_id": parent,
        "attributes": attributes,
        "start_time": start,
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
    assert delegated_calls(spans, [CONFIRM]) == [
        ("ask_payments", {}),
        ("list_beneficiaries", {}),
        ("prepare_transfer", {"beneficiary_id": "ben-ana-juan", "amount": Decimal("10000.00"), "currency": "ARS"}),
    ]


def test_without_a_handoff_nothing_is_delegated() -> None:
    assert delegated_calls([_span("a", None, "prepare_transfer", "1")], [CONFIRM]) == []
