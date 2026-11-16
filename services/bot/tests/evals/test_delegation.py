"""The eval hook reads a subagent's calls from the run's spans and their arguments from the cards."""

from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest

from app.guardrails.stream_timing import RUN_ID_ATTRIBUTE
from app.policy.policy_toolset import POLICY_DENIED_ATTRIBUTE
from evals import delegation
from evals.agui_client import RunTrace
from evals.calls import ObservedCall
from evals.cuj_evaluators import Handoffs
from evals.delegation import cards_by_trace, delegated_calls
from evals.live import LiveOutput

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
    assert delegated_calls(spans, {"t": [CONFIRM["data"]]}) == [
        ObservedCall("ask_payments", delegated=True),
        ObservedCall("list_beneficiaries", delegated=True),
        ObservedCall("prepare_transfer", prepared, delegated=True),
    ]


def test_without_a_handoff_nothing_is_delegated() -> None:
    assert delegated_calls([_span("a", None, "prepare_transfer", "1")], {"t": [CONFIRM["data"]]}) == []


def test_the_mcp_transport_span_does_not_count_as_a_second_call_and_carries_the_error() -> None:
    transport = _span("rpc", "prep", "prepare_transfer", "7", status="ERROR", message='{"error":"insufficient_funds"}')
    transport["attributes"]["mcp.method.name"] = "tools/call"
    spans = [
        _span("ask", None, "ask_payments", "1"),
        _span("prep", "ask", "prepare_transfer", "2", status="ERROR"),
        transport,
    ]

    calls = delegated_calls(spans, {})

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

    assert [c.outcome for c in delegated_calls(spans, {})] == ["result", "error:insufficient_funds"]


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
    cards = {"t": [_confirm("drf_1", "10000.00")["data"], _confirm("drf_2", "25000.00")["data"]]}

    prepares = [c for c in delegated_calls(spans, cards) if c.name == "prepare_transfer"]

    assert [c.args.get("amount") for c in prepares] == [Decimal("10000.00"), None, Decimal("25000.00")]


def test_the_gateways_retry_after_is_read_from_the_error() -> None:
    message = '{"error":"rate_limited","retry_after_seconds":37}'
    spans = [
        _span("ask", None, "ask_payments", "1"),
        _span("p", "ask", "prepare_transfer", "2", status="ERROR", message=message),
    ]

    [_, prepare] = delegated_calls(spans, {})

    assert (prepare.outcome, prepare.retry_after_seconds) == ("error:rate_limited", 37)


def test_an_error_in_a_child_span_does_not_fail_a_call_that_succeeded() -> None:
    child = _span("rpc", "prep", "prepare_transfer", "3", status="ERROR", message='{"error":"insufficient_funds"}')
    child["attributes"]["mcp.method.name"] = "tools/call"
    spans = [_span("ask", None, "ask_payments", "1"), _span("prep", "ask", "prepare_transfer", "2", status="OK"), child]

    [_, prepare] = delegated_calls(spans, {"t": [CONFIRM["data"]]})

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
    monkeypatch.setattr(delegation, "LATE_EXPORT_WAIT_SECONDS", 0.0)

    from datetime import UTC, datetime

    result = await delegation.read_delegated("thr", datetime.now(UTC), [RunTrace([]), RunTrace([])])

    assert [c.name for c in result.calls] == ["ask_payments"]
    assert "1 of 2 runs" in result.note  # The gap is reported, not hidden.


def _policy_denied(span: dict[str, Any]) -> dict[str, Any]:
    span["attributes"][POLICY_DENIED_ATTRIBUTE] = True
    return span


def test_a_call_the_policy_refused_reads_as_policy_denied_and_takes_no_card() -> None:
    spans = [
        _span("ask", None, "ask_payments", "1"),
        _policy_denied(_span("prep", "ask", "prepare_transfer", "2")),  # A normal result, so the span is not ERROR.
    ]

    [_, prepare] = delegated_calls(spans, {"t": [CONFIRM["data"]]})

    assert (prepare.outcome, prepare.args) == ("error:policy_denied", {})


def test_a_failed_handoff_reads_as_its_error_and_is_no_handoff() -> None:
    spans = [_span("ask", None, "ask_payments", "1", status="ERROR", message='{"error":"unavailable"}')]

    [handoff] = delegated_calls(spans, {})
    output = LiveOutput([], delegated=[handoff])

    assert handoff.outcome == "error:unavailable"
    assert output.handoffs == set()
    assert not Handoffs(["payments"]).evaluate(SimpleNamespace(output=output)).value  # type: ignore[arg-type]


def test_a_refused_handoff_is_no_handoff_either() -> None:
    spans = [_policy_denied(_span("ask", None, "ask_payments", "1"))]

    [handoff] = delegated_calls(spans, {})

    assert handoff.outcome == "error:policy_denied"
    assert LiveOutput([], delegated=[handoff]).handoffs == set()


def _stream(trace: str, start: str, run_id: str | None = None) -> dict[str, Any]:
    attributes = {RUN_ID_ATTRIBUTE: run_id} if run_id else {}
    return {"context": {"trace_id": trace, "span_id": f"s-{trace}"}, "attributes": attributes, "start_time": start}


def _run(run_id: str, *drafts: str) -> RunTrace:
    started = {"type": "RUN_STARTED", "runId": run_id}
    return RunTrace([started, *(_confirm(d, "1.00") | {"type": "ACTIVITY_SNAPSHOT", "activityType": "bank-template",
                                                        "content": _confirm(d, "1.00")} for d in drafts)])  # fmt: skip


def test_a_late_run_does_not_shift_the_cards_of_the_runs_that_arrived() -> None:
    runs = [_run("r1", "drf_1"), _run("r2", "drf_2"), _run("r3", "drf_3")]
    arrived = [_stream("t1", "1", "r1"), _stream("t3", "3", "r3")]  # r2's spans are late.

    by_trace = cards_by_trace(arrived, runs).cards

    assert {t: [c["draftId"] for c in cards] for t, cards in by_trace.items()} == {"t1": ["drf_1"], "t3": ["drf_3"]}


def test_a_stream_without_an_id_and_a_late_run_leave_out_only_themselves() -> None:
    runs = [_run("r1", "drf_1"), _run("r2", "drf_2"), _run("r3", "drf_3"), _run("r4", "drf_4")]
    arrived = [_stream("t1", "1", "r1"), _stream("t2", "2"), _stream("t4", "4", "r4")]  # r2 has no id, r3 is late.

    by_trace = cards_by_trace(arrived, runs).cards

    assert {t: [c["draftId"] for c in cards] for t, cards in by_trace.items()} == {"t1": ["drf_1"], "t4": ["drf_4"]}


def test_a_trace_no_run_matches_is_counted_never_paired_by_order() -> None:
    runs = [_run("r1", "drf_1"), _run("r2", "drf_2")]
    restore = _stream("t0", "0", "restore-9")  # A BFF restore's RUN_STARTED id, which no client run carries.

    paired = cards_by_trace([restore, _stream("t1", "1"), _stream("t2", "2", "r2")], runs)

    assert {t: [c["draftId"] for c in cards] for t, cards in paired.cards.items()} == {"t2": ["drf_2"]}
    assert paired.unpaired == 2


async def test_unpaired_traces_make_the_trial_note_a_gap(monkeypatch: pytest.MonkeyPatch) -> None:
    streams = [
        {"context": {"trace_id": "t", "span_id": "s"}, "attributes": {delegation.THREAD_ATTRIBUTE: "thr"}},
    ]
    handoff = _span("ask", None, "ask_payments", "1")

    def fake_spans(_since: object, **filters: object) -> list[dict[str, Any]]:
        return streams if filters.get("name") == "bot.stream" else [handoff]

    monkeypatch.setattr(delegation, "spans", fake_spans)

    from datetime import UTC, datetime

    result = await delegation.read_delegated("thr", datetime.now(UTC), [_run("r1")])

    assert "1 traces could not be paired" in result.note


def test_a_failed_handoff_reads_its_own_error_never_an_inner_tool_s() -> None:
    inner = _span("prep", "ask", "prepare_transfer", "2", status="ERROR", message='{"error":"insufficient_funds"}')
    spans = [_span("ask", None, "ask_payments", "1", status="ERROR"), inner]

    [handoff, prepare] = delegated_calls(spans, {})

    assert handoff.outcome == "error:unknown"
    assert prepare.outcome == "error:insufficient_funds"


def test_a_draft_belongs_to_the_first_run_that_showed_its_card() -> None:
    runs = [_run("r1", "drf_1"), _run("r2", "drf_1", "drf_2")]

    by_trace = cards_by_trace([_stream("t1", "1", "r1"), _stream("t2", "2", "r2")], runs).cards

    assert [c["draftId"] for c in by_trace["t2"]] == ["drf_2"]
