"""The CUJ evaluators fail on what they claim to catch: forbidden, unexpected and missing calls, a call that never
paused, a wrong outcome, and a ledger, card or step-up count that does not match."""

import json
from decimal import Decimal
from typing import Any

from pydantic_evals.evaluators import EvaluationReason, EvaluatorContext
from pydantic_evals.otel._errors import SpanTreeRecordingError

from evals.agui_client import RunTrace
from evals.bank_db import Ledger
from evals.calls import CANCELLED, PAUSED, ObservedCall, result_outcome
from evals.cuj import Step
from evals.cuj_evaluators import (
    BalanceMatchesLedger,
    Cards,
    Handoffs,
    Interrupts,
    LedgerDelta,
    Problem,
    StepUpAttempts,
    Trajectory,
    trajectory_problems,
)
from evals.live import LiveInput, LiveOutput

STEPS = [
    Step(tool="ask_payments"),
    Step(tool="prepare_transfer", args={"beneficiary_id": "ben-juan-ana", "amount": 50000}),
    Step(tool="execute_transfer", outcome="paused"),
    Step(tool="execute_transfer"),
]
ALLOW = ["list_beneficiaries", "get_balance"]
FORBID: list[str] = []
PREPARE = ObservedCall("prepare_transfer", {"beneficiary_id": "ben-juan-ana", "amount": Decimal("50000.00")})


def _ctx(output: LiveOutput) -> EvaluatorContext[LiveInput, LiveOutput, dict[str, str]]:
    return EvaluatorContext(
        name="c", inputs=LiveInput(turns=["hola"]), metadata=None, expected_output=None, output=output,
        duration=0.0, _span_tree=SpanTreeRecordingError("n/a"), attributes={}, metrics={},
    )  # fmt: skip


def _ok(result: bool | EvaluationReason) -> bool:
    return bool(result.value if isinstance(result, EvaluationReason) else result)


def _run(events: list[dict[str, Any]], interrupts: list[str] | None = None) -> RunTrace:
    outcome = {"type": "interrupt", "interrupts": [{"id": f"int-{i}", "toolCallId": i} for i in interrupts or []]}
    finished = {"type": "RUN_FINISHED", "outcome": outcome if interrupts else {"type": "success"}}
    return RunTrace([*events, finished])


def _call(call_id: str, name: str, args: dict[str, Any] | None = None, result: str | None = None) -> list[Any]:
    events: list[dict[str, Any]] = [
        {"type": "TOOL_CALL_START", "toolCallId": call_id, "toolCallName": name},
        {"type": "TOOL_CALL_ARGS", "toolCallId": call_id, "delta": json.dumps(args or {})},
    ]
    if result is not None:
        events.append({"type": "TOOL_CALL_RESULT", "toolCallId": call_id, "messageId": "m", "content": result})
    return events


def _transfer_traces(resume_content: str = '{"untrusted_data": {"reference": "BD-1"}}') -> list[RunTrace]:
    first = _run([*_call("a", "ask_payments", result=""), *_call("x", "execute_transfer")], interrupts=["x"])
    resumed = _run([{"type": "TOOL_CALL_RESULT", "toolCallId": "x", "messageId": "r", "content": resume_content}])
    return [first, resumed]


def _delegated() -> list[ObservedCall]:
    handoff = ObservedCall("ask_payments", delegated=True)
    return [handoff, ObservedCall("list_beneficiaries", delegated=True), PREPARE]


def _output(traces: list[RunTrace], **fields: Any) -> LiveOutput:
    return LiveOutput(traces, delegated=_delegated(), **fields)


def test_a_transfer_that_pauses_then_resolves_is_the_expected_trajectory() -> None:
    result = Trajectory(STEPS, ALLOW, FORBID).evaluate(_ctx(_output(_transfer_traces())))

    assert _ok(result), result


def test_the_trajectory_reads_the_subagents_calls_after_its_handoff() -> None:
    calls = _output(_transfer_traces()).calls

    assert [(c.name, c.outcome) for c in calls] == [
        ("ask_payments", "result"),
        ("list_beneficiaries", "result"),
        ("prepare_transfer", "result"),
        ("execute_transfer", PAUSED),
        ("execute_transfer", "result"),
    ]


def test_execute_transfer_without_approval_fails_the_trajectory() -> None:
    # The model calls execute_transfer and it runs at once: no interrupt, so it was never paused.
    traces = [_run([*_call("a", "ask_payments", result=""), *_call("x", "execute_transfer", result="{}")])]
    forbid = ["execute_transfer:result"]

    result = Trajectory(STEPS, ALLOW, forbid).evaluate(_ctx(_output(traces)))

    assert not _ok(result)
    assert "forbidden execute_transfer (result)" in str(result.reason)


def test_an_execute_that_resolves_without_ever_pausing_fails_even_when_not_forbidden() -> None:
    traces = [_run([*_call("a", "ask_payments", result=""), *_call("x", "execute_transfer", result="{}")])]

    assert not _ok(Trajectory(STEPS, ALLOW, FORBID).evaluate(_ctx(_output(traces))))


def test_an_extra_prepare_transfer_fails_through_the_evaluator() -> None:
    output = _output(_transfer_traces())
    output.delegated = [*_delegated(), PREPARE]

    result = Trajectory(STEPS, ALLOW, FORBID).evaluate(_ctx(output))

    assert not _ok(result)
    assert "unexpected prepare_transfer" in str(result.reason)


def test_a_missing_step_is_reported() -> None:
    problems = trajectory_problems([ObservedCall("ask_payments")], STEPS, ALLOW, FORBID)

    assert [str(p) for p in problems if p.kind == "missing"] == [
        "missing prepare_transfer (result)",
        "missing execute_transfer (paused)",
        "missing execute_transfer (result)",
    ]


def test_arguments_are_compared_numerically() -> None:
    wrong = ObservedCall("prepare_transfer", {"beneficiary_id": "ben-juan-ana", "amount": Decimal("500.00")})

    problems = trajectory_problems([wrong], [Step(tool="prepare_transfer", args={"amount": 50000})], [], [])

    assert any("unexpected prepare_transfer" in str(p) for p in problems)


def test_a_refused_interrupt_is_cancelled_not_a_result() -> None:
    traces = _transfer_traces("El cliente canceló la transferencia.")
    traces[1].cancelled = frozenset({"x"})
    calls = _output(traces).calls
    steps = [
        Step(tool="ask_payments"),
        Step(tool="execute_transfer", outcome="paused"),
        Step(tool="execute_transfer", outcome="cancelled"),
    ]

    assert [(c.name, c.outcome) for c in calls][-2:] == [("execute_transfer", PAUSED), ("execute_transfer", CANCELLED)]
    assert trajectory_problems(calls, steps, [*ALLOW, "prepare_transfer"], ["execute_transfer:result"]) == []


def test_a_tool_error_is_an_error_outcome() -> None:
    assert result_outcome('{"untrusted_data": {"error": "draft_expired", "message": "x"}}') == "error:draft_expired"
    assert result_outcome('{"error": "insufficient_funds"}') == "error:insufficient_funds"
    assert result_outcome('{"untrusted_data": {"balance": "1.00"}}') == "result"
    assert result_outcome("not json") == "result"


def test_handoffs_come_from_the_spans_not_the_client() -> None:
    with_span = _output(_transfer_traces())
    without = LiveOutput(_transfer_traces())

    assert _ok(Handoffs(["payments"]).evaluate(_ctx(with_span)))
    assert not _ok(Handoffs(["payments"]).evaluate(_ctx(without)))


def test_interrupt_count() -> None:
    output = _output(_transfer_traces())

    assert _ok(Interrupts(1).evaluate(_ctx(output)))
    assert not _ok(Interrupts(0).evaluate(_ctx(output)))


def test_cards_present_and_absent() -> None:
    content = {"template": "transfer-confirm"}
    confirm = {"type": "ACTIVITY_SNAPSHOT", "activityType": "bank-template", "content": content}
    output = LiveOutput([_run([confirm])])

    assert _ok(Cards(["transfer-confirm"], ["transfer-receipt"]).evaluate(_ctx(output)))
    assert not _ok(Cards([], ["transfer-confirm"]).evaluate(_ctx(output)))
    assert not _ok(Cards(["transfer-receipt"], []).evaluate(_ctx(output)))


def test_ledger_none_fails_when_money_moved() -> None:
    moved = LiveOutput([], ledger_change=Ledger(Decimal("-50000"), 1, 1))
    still = LiveOutput([], ledger_change=Ledger(Decimal(0), 0, 0))

    assert _ok(LedgerDelta("none").evaluate(_ctx(still)))
    assert not _ok(LedgerDelta("none").evaluate(_ctx(moved)))
    assert not _ok(LedgerDelta("none").evaluate(_ctx(LiveOutput([]))))


def test_step_up_attempts() -> None:
    output = LiveOutput([], step_up_statuses=[401, 200])

    assert _ok(StepUpAttempts(2, [401, 200]).evaluate(_ctx(output)))
    assert not _ok(StepUpAttempts(1, None).evaluate(_ctx(output)))
    assert not _ok(StepUpAttempts(None, [200, 200]).evaluate(_ctx(output)))


def test_the_balance_read_must_show_the_ledgers_balance() -> None:
    balance = _run(_call("b", "get_balance", result='{"untrusted_data": {"balance": "436750.25"}}'))
    after = Ledger(Decimal("436750.25"), 0, 0)

    assert _ok(BalanceMatchesLedger().evaluate(_ctx(LiveOutput([balance], ledger_after=after))))
    stale = Ledger(Decimal("486750.25"), 0, 0)
    assert not _ok(BalanceMatchesLedger().evaluate(_ctx(LiveOutput([balance], ledger_after=stale))))


EXPIRED_RETRY_RULE = ["execute_transfer:paused <- prepare_transfer:result"]


def _texts(problems: list[Problem]) -> list[str]:
    return [str(p) for p in problems]


def _paused_execute() -> ObservedCall:
    return ObservedCall("execute_transfer", outcome=PAUSED)


def test_a_second_approval_card_needs_a_new_prepare_transfer() -> None:
    expired = ObservedCall("execute_transfer", outcome="error:draft_expired")
    steps = [
        Step(tool="prepare_transfer"),
        Step(tool="execute_transfer", outcome="paused"),
        Step(tool="execute_transfer", outcome="error:draft_expired"),
    ]
    allow = ["ask_payments", "prepare_transfer", "execute_transfer:paused"]
    retry_without_prepare = [PREPARE, _paused_execute(), expired, ObservedCall("ask_payments"), _paused_execute()]
    retry_with_prepare = [PREPARE, _paused_execute(), expired, ObservedCall("ask_payments"), PREPARE, _paused_execute()]

    assert trajectory_problems(retry_with_prepare, steps, allow, [], EXPIRED_RETRY_RULE) == []
    [problem] = trajectory_problems(retry_without_prepare, steps, allow, [], EXPIRED_RETRY_RULE)
    assert str(problem) == f"execute_transfer (paused) without a new prepare_transfer:result ({EXPIRED_RETRY_RULE[0]})"


def test_allow_can_name_an_outcome() -> None:
    steps = [Step(tool="prepare_transfer")]

    assert trajectory_problems([PREPARE, _paused_execute()], steps, ["execute_transfer:paused"], []) == []
    assert _texts(
        trajectory_problems([PREPARE, ObservedCall("execute_transfer")], steps, ["execute_transfer:paused"], [])
    ) == ["unexpected execute_transfer (result) after 1 of 1 steps"]


def test_a_failed_re_prepare_is_not_a_fresh_draft() -> None:
    steps = [Step(tool="prepare_transfer"), Step(tool="execute_transfer", outcome="paused")]
    allow = [
        "ask_payments",
        "prepare_transfer:error:insufficient_funds",
        "execute_transfer:paused",
        "execute_transfer:error:draft_expired",
    ]
    failed_prepare = ObservedCall("prepare_transfer", outcome="error:insufficient_funds")
    expired = ObservedCall("execute_transfer", outcome="error:draft_expired")
    calls = [PREPARE, _paused_execute(), expired, failed_prepare, _paused_execute()]

    problems = trajectory_problems(calls, steps, allow, [], EXPIRED_RETRY_RULE)

    assert [p.kind for p in problems] == ["unmet"]
