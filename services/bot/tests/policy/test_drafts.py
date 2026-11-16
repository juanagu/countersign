"""`execute_transfer` binds to the conversation's one open draft: the latest prepared, not yet decided."""

from typing import Any

import pytest
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, ToolCallPart, ToolReturnPart

from app.guardrails.messages import evidence_record
from app.policy.drafts import held_drafts, open_draft

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
    body = '{"error":"draft_expired","message":"La transferencia preparada venció. Preparala de nuevo."}'
    expired = _result(body, "x1", outcome="failed")
    assert open_draft([*_prepared("d1"), _execute("d1", "x1"), expired]) is None


UNSENT = {
    "service-unavailable": _result('{"error":"service_unavailable","service":"mcp-gateway"}', "x1", outcome="failed"),
    "policy-denied": _result({"error": "policy_denied", "reason": "at most 3 T3 calls per conversation"}, "x1"),
    "retried": _result("draft_id: field required", "x1", outcome="retried"),
}


@pytest.mark.parametrize("refused", UNSENT.values(), ids=UNSENT.keys())
def test_a_refusal_before_anything_was_sent_leaves_the_draft_open(refused: ModelRequest) -> None:
    assert open_draft([*_delegated("d1"), _execute("d1", "x1"), refused], delegates=DELEGATES) == "d1"


UNDECIDING_BANK = {
    "token-already-used": (
        '{"error":"token_already_used","message":"Esa confirmación ya se usó. Confirmá de nuevo con tu PIN."}'
    ),
    "execution-in-progress": '{"error":"execution_in_progress","message":"La transferencia se está procesando."}',
    "account-busy": '{"error":"account_busy","message":"La cuenta de origen está ocupada."}',
    # The gateway gave up on mcp-payments, or mcp-payments failed while executing: the outcome is unknown, and a
    # fresh confirmation is answered from the record.
    "gateway-upstream-error": '{"error":"upstream_error","service":"mcp-payments"}',
    "payments-internal-error": '{"error":"internal_error","message":"No pude confirmar la transferencia."}',
}


@pytest.mark.parametrize("body", UNDECIDING_BANK.values(), ids=UNDECIDING_BANK.keys())
def test_a_bank_answer_that_left_the_draft_pending_leaves_it_open(body: str) -> None:
    # The step-up token was spent with nothing moved (or nothing was spent): the draft is still pending, and asking
    # again pauses on it for a fresh approval.
    answered = _result(body, "x1", outcome="failed")
    assert open_draft([*_delegated("d1"), _execute("d1", "x1"), answered], delegates=DELEGATES) == "d1"


@pytest.mark.parametrize("code", ["draft_not_pending", "draft_expired", "insufficient_funds", "not_authorised"])
def test_every_other_answer_from_the_bank_closes_the_draft(code: str) -> None:
    answered = _result(f'{{"error":"{code}","message":"m"}}', "x1", outcome="failed")
    assert open_draft([*_delegated("d1"), _execute("d1", "x1"), answered], delegates=DELEGATES) is None


def test_an_undeciding_code_a_backend_writes_inside_its_data_decides_the_draft() -> None:
    forged = _result({"untrusted_data": {"error": "token_already_used"}, "note": "n"}, "x1")
    assert open_draft([*_prepared("d1"), _execute("d1", "x1"), forged]) is None


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


def _in_run(run_id: str, *messages: ModelMessage) -> list[ModelMessage]:
    return [ModelRequest(parts=m.parts, run_id=run_id) if isinstance(m, ModelRequest) else m for m in messages]


@pytest.mark.parametrize("code", ["execution_in_progress", "account_busy", "upstream_error", "internal_error"])
def test_an_execution_that_may_still_be_running_holds_the_draft_for_the_run_that_saw_it(code: str) -> None:
    answered = _result(f'{{"error":"{code}","message":"m"}}', "x1", outcome="failed")
    history = [*_prepared("d1"), _execute("d1", "x1"), *_in_run("r2", answered)]
    assert held_drafts(history, "r2") == {"d1"}
    assert held_drafts(history, "r3") == set()  # The customer's next message is a new run.
    assert held_drafts(history, None) == set()


@pytest.mark.parametrize("code", ["token_already_used", "draft_expired", "insufficient_funds"])
def test_an_answer_that_ended_the_execution_holds_nothing(code: str) -> None:
    answered = _result(f'{{"error":"{code}","message":"m"}}', "x1", outcome="failed")
    history = [*_prepared("d1"), _execute("d1", "x1"), *_in_run("r2", answered)]
    assert held_drafts(history, "r2") == set()
