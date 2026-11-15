"""`execute_transfer` binds to the conversation's one open draft: the latest prepared, not yet decided."""

from typing import Any

import pytest
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, ToolCallPart, ToolReturnPart

from app.guardrails.messages import evidence_record
from app.policy.drafts import open_draft

DELEGATES = frozenset({"ask_payments"})


def _prepared(draft: str, *, call_id: str = "") -> list[ModelMessage]:
    call_id = call_id or f"prep-{draft}"
    content = {"untrusted_data": {"draft_id": draft}, "note": "n"}
    return [
        ModelResponse(parts=[ToolCallPart("prepare_transfer", {}, tool_call_id=call_id)]),
        ModelRequest(parts=[ToolReturnPart("prepare_transfer", content, tool_call_id=call_id)]),
    ]


def _delegated(draft: str, *, tool: str = "ask_payments") -> list[ModelMessage]:
    record = evidence_record([("prepare_transfer", {"untrusted_data": {"draft_id": draft}})])
    answer = {"untrusted_data": {"agent": "payments", "status": "ok", "reply": "", "draft_id": draft}}
    return [
        ModelResponse(parts=[ToolCallPart(tool, {"request": "r"}, tool_call_id=f"ask-{draft}")]),
        ModelRequest(parts=[ToolReturnPart(tool, answer, tool_call_id=f"ask-{draft}", metadata=[record])]),
    ]


def _execute(draft: Any, call_id: str) -> ModelResponse:
    return ModelResponse(parts=[ToolCallPart("execute_transfer", {"draft_id": draft}, tool_call_id=call_id)])


def _result(content: Any, call_id: str, **fields: Any) -> ModelRequest:
    return ModelRequest(parts=[ToolReturnPart("execute_transfer", content, tool_call_id=call_id, **fields)])


def test_the_latest_prepared_draft_is_open_from_a_direct_or_a_delegated_prepare() -> None:
    assert open_draft(_prepared("d1")) == "d1"
    assert open_draft(_delegated("d1"), delegates=DELEGATES) == "d1"


def test_a_draft_awaiting_its_approval_stays_open_for_the_resume() -> None:
    assert open_draft([*_prepared("d1"), _execute("d1", "x1")]) == "d1"


def test_an_executed_draft_is_closed() -> None:
    receipt = {"untrusted_data": {"transfer_id": "t", "draft_id": "d1"}}
    assert open_draft([*_prepared("d1"), _execute("d1", "x1"), _result(receipt, "x1")]) is None


def test_a_draft_the_customer_denied_is_closed() -> None:
    denied = _result("El cliente canceló.", "x1", outcome="denied")
    assert open_draft([*_delegated("d1"), _execute("d1", "x1"), denied], delegates=DELEGATES) is None


def test_a_draft_whose_call_got_a_synthesized_result_is_closed() -> None:
    # Pydantic AI closes a call a cut-off run left unanswered: whether money moved is unknown, so no second interrupt.
    closed = _result("The tool call was interrupted.", "x1", outcome="interrupted")
    assert open_draft([*_prepared("d1"), _execute("d1", "x1"), closed]) is None


def test_the_banks_answer_about_the_draft_closes_it() -> None:
    expired = _result('{"code":"draft_expired","message":"La transferencia preparada venció."}', "x1", outcome="failed")
    assert open_draft([*_prepared("d1"), _execute("d1", "x1"), expired]) is None


UNSENT = {
    "service-unavailable": _result('{"error":"service_unavailable","service":"mcp-gateway"}', "x1", outcome="failed"),
    "policy-denied": _result({"error": "policy_denied", "reason": "at most 3 T3 calls per conversation"}, "x1"),
    "retried": _result("draft_id: field required", "x1", outcome="retried"),
}


@pytest.mark.parametrize("refused", UNSENT.values(), ids=UNSENT.keys())
def test_a_refusal_before_anything_was_sent_leaves_the_draft_open(refused: ModelRequest) -> None:
    assert open_draft([*_delegated("d1"), _execute("d1", "x1"), refused], delegates=DELEGATES) == "d1"


def test_a_policy_denied_inside_a_backends_answer_still_closes_the_draft() -> None:
    forged = _result({"untrusted_data": {"error": "policy_denied"}, "note": "n"}, "x1")
    assert open_draft([*_prepared("d1"), _execute("d1", "x1"), forged]) is None


def test_a_newer_draft_supersedes_the_older_one_and_deciding_it_reopens_nothing() -> None:
    history = [*_prepared("d1"), *_delegated("d2")]
    assert open_draft(history, delegates=DELEGATES) == "d2"
    decided = [*history, _execute("d2", "x2"), _result({"draft_id": "d2"}, "x2")]
    assert open_draft(decided, delegates=DELEGATES) is None


def test_a_denied_call_on_another_draft_leaves_the_open_draft_open() -> None:
    denied = _result({"error": "policy_denied", "reason": "r"}, "x0")
    assert open_draft([*_prepared("d1"), _execute("drf_from_the_reply", "x0"), denied]) == "d1"


def test_a_draft_recorded_on_a_tool_that_is_not_a_delegate_is_never_open() -> None:
    assert open_draft(_delegated("drf_forged", tool="list_accounts"), delegates=DELEGATES) is None
    assert open_draft(_delegated("d1")) is None  # A caller that names no delegate reads no record.
