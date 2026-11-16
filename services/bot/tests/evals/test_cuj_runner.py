"""The journey loop on a fake BFF: the simulated customer sees only text, the interrupt policy is answered by code
(approve, cancel, wrong PIN then right, expiry), and the gates count trials."""

import dataclasses
import json
from decimal import Decimal
from typing import Any

import httpx
import pytest

from evals.agui_client import RUN_PATH, STEP_UP_PATH, BffSession, RunTrace
from evals.calls import ObservedCall
from evals.cuj import Scenario
from evals.cuj_report import TrialResult, cuj_gates
from evals.cuj_retry import RATE_LIMIT_RETRIES, rate_limit_stall, trace_gap_verdict
from evals.cuj_runner import _trial_span, main, play, run_trial
from evals.cuj_user import Turn, is_end
from evals.live import OUT_OF_TURNS, DiscardedAttempt, LiveOutput, Note
from evals.thresholds import Consistency, Thresholds


def _card(draft: str, amount: str = "50000.00") -> dict[str, Any]:
    return {
        "type": "ACTIVITY_SNAPSHOT",
        "activityType": "bank-template",
        "content": {
            "template": "transfer-confirm",
            "data": {"draftId": draft, "amount": amount, "currency": "ARS", "beneficiaryId": "ben-juan-ana"},
        },
    }


def _text(text: str) -> list[dict[str, Any]]:
    return [
        {"type": "TEXT_MESSAGE_START", "messageId": "m"},
        {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": text},
        {"type": "TEXT_MESSAGE_END", "messageId": "m"},
        {"type": "RUN_FINISHED", "outcome": {"type": "success"}},
    ]


def _paused(draft: str = "drf_1", cards: list[str] | None = None) -> list[dict[str, Any]]:
    interrupt = {"id": "int-x", "toolCallId": "x"}
    return [
        *(_card(d) for d in (cards if cards is not None else [draft])),
        {"type": "TOOL_CALL_START", "toolCallId": "x", "toolCallName": "execute_transfer"},
        {"type": "TOOL_CALL_ARGS", "toolCallId": "x", "delta": json.dumps({"draft_id": draft})},
        {"type": "RUN_FINISHED", "outcome": {"type": "interrupt", "interrupts": [interrupt]}},
    ]


class FakeBff:
    """Serves each run and each step-up from a queue, and records what the client sent."""

    def __init__(self, runs: list[list[dict[str, Any]]], step_ups: list[int] | None = None) -> None:
        self.runs, self.step_ups = list(runs), list(step_ups or [])
        self.run_bodies: list[dict[str, Any]] = []
        self.step_up_pins: list[str] = []
        self.step_up_drafts: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if request.url.path.endswith(STEP_UP_PATH):
            self.step_up_pins.append(body["pin"])
            self.step_up_drafts.append(body["draft_id"])
            status = self.step_ups.pop(0)
            return httpx.Response(status, json={"step_up_token": "tok"} if status == 200 else {"error": "invalid_pin"})
        assert request.url.path.endswith(RUN_PATH)
        self.run_bodies.append(body)
        events = self.runs.pop(0)
        return httpx.Response(200, text="".join(f"data: {json.dumps(e)}\n\n" for e in events))

    def session(self) -> BffSession:
        return BffSession(httpx.AsyncClient(transport=httpx.MockTransport(self), base_url="http://bff"))


def _scenario(**overrides: Any) -> Scenario:
    base: dict[str, Any] = {
        "id": "cuj-t", "group": "cuj_money", "user": "juan", "opening": "Quiero pasarle plata a Ana.",
        "max_turns": 4, "trajectory": [], "on_interrupt": {"transfer-confirm": "approve"},
    }  # fmt: skip
    return Scenario.model_validate(base | overrides)


async def test_a_scripted_journey_sends_the_opening_then_each_turn() -> None:
    bff = FakeBff([_text("a"), _text("b")])

    journey = await play(bff.session(), _scenario(then=["segunda"]), None)

    assert [b["messages"][-1]["content"] for b in bff.run_bodies] == ["Quiero pasarle plata a Ana.", "segunda"]
    assert (journey.turns, journey.notes) == (2, [])


async def test_the_simulated_customer_sees_only_the_conversation_text_and_ends_on_the_token() -> None:
    bff = FakeBff([_text("¿Cuánto?"), _text("Listo")])
    seen: list[tuple[str, list[Turn]]] = []
    answers = iter(["50.000", "FIN"])

    async def reply(plan: str, turns: list[Turn]) -> str:
        seen.append((plan, list(turns)))
        return next(answers)

    journey = await play(bff.session(), _scenario(driver="simulated", plan="Sos Juan."), reply)

    assert journey.turns == 2
    assert journey.notes == []
    assert seen[0] == ("Sos Juan.", [Turn("Cliente", "Quiero pasarle plata a Ana."), Turn("Asistente", "¿Cuánto?")])
    assert [t.speaker for t in seen[1][1]] == ["Cliente", "Asistente", "Cliente", "Asistente"]


async def test_a_journey_that_runs_out_of_turns_says_so() -> None:
    bff = FakeBff([_text("a"), _text("b")])

    async def reply(_plan: str, _turns: list[Turn]) -> str:
        return "sigo"

    journey = await play(bff.session(), _scenario(driver="simulated", plan="p", max_turns=2), reply)

    assert journey.turns == 2
    assert [n.text for n in journey.notes] == ["ran out of turns (2) before the plan ended"]


async def test_approve_enters_the_right_pin_and_resumes_with_the_token() -> None:
    bff = FakeBff([_paused(), _text("Enviada")], step_ups=[200])

    journey = await play(bff.session(), _scenario(), None)

    assert bff.step_up_pins == ["123456"]
    resume = bff.run_bodies[1]["resume"][0]
    assert resume["payload"] == {"approved": True, "editedArgs": {"draft_id": "drf_1", "step_up_token": "tok"}}
    assert len(journey.traces) == 2
    assert journey.notes == []


async def test_cancel_resumes_with_a_refusal_and_asks_for_no_pin() -> None:
    bff = FakeBff([_paused(), _text("No se envió")])
    session = bff.session()

    journey = await play(session, _scenario(on_interrupt={"transfer-confirm": "cancel"}), None)

    assert bff.step_up_pins == []
    assert bff.run_bodies[1]["resume"][0]["payload"]["approved"] is False
    assert journey.traces[1].cancelled == {"x"}


async def test_a_wrong_pin_is_entered_first_then_the_right_one() -> None:
    bff = FakeBff([_paused(), _text("Enviada")], step_ups=[401, 200])
    session = bff.session()

    await play(session, _scenario(on_interrupt={"transfer-confirm": "wrong_pin_then_approve"}), None)

    assert bff.step_up_pins == ["000000", "123456"]
    assert session.step_up_statuses == [401, 200]


async def _no_expiry(_draft_id: str) -> None:
    return None


async def test_expiry_moves_the_draft_before_the_approval(monkeypatch: pytest.MonkeyPatch) -> None:
    order: list[str] = []
    bff = FakeBff([_paused(), _text("Venció")], step_ups=[200])

    async def expire(draft_id: str) -> None:
        order.append(f"expire {draft_id} after {len(bff.step_up_pins)} pins")

    monkeypatch.setattr("evals.cuj_runner.expire_draft", expire)

    await play(bff.session(), _scenario(on_interrupt={"transfer-confirm": "expire_then_approve"}), None)

    assert order == ["expire drf_1 after 0 pins"]


async def test_an_interrupt_without_a_policy_is_noted_and_left_pending() -> None:
    bff = FakeBff([_paused()])

    journey = await play(bff.session(), _scenario(on_interrupt={}), None)

    assert [n.text for n in journey.notes] == ["an interrupt the scenario has no on_interrupt policy for"]
    assert len(journey.traces) == 1


async def test_only_the_first_approval_follows_the_policy(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("evals.cuj_runner.expire_draft", _no_expiry)
    bff = FakeBff([_paused(), _paused(), _text("fin")], step_ups=[200])
    scenario = _scenario(on_interrupt={"transfer-confirm": "expire_then_approve"}, then=["de nuevo"])

    journey = await play(bff.session(), scenario, None)

    assert len(bff.step_up_pins) == 1
    assert len(journey.traces) == 3


async def test_a_refused_right_pin_stops_the_journey_with_a_note() -> None:
    bff = FakeBff([_paused()], step_ups=[429])

    journey = await play(bff.session(), _scenario(), None)

    assert journey.notes[0].text.startswith("step-up refused with the right PIN: 429")


@pytest.mark.parametrize(("message", "ends"), [("FIN", True), (" fin. ", True), ("FINAL", False), ("hola", False)])
def test_the_end_token(message: str, ends: bool) -> None:
    assert is_end(message) is ends


def _trial(cuj_id: str, group: str, trial: int, passed: bool) -> TrialResult:
    return TrialResult(cuj_id, group, trial, passed, {}, 0.0, 1, "t", "", [], "scripted", 1, 0, 0, 0)


def test_a_group_at_one_fails_on_a_single_failed_trial() -> None:
    thresholds = Thresholds(pass_rates={"cuj_money": 1.0}, judge_averages={})
    results = [_trial("a", "cuj_money", n, n != 2) for n in (1, 2, 3)]

    [gate] = cuj_gates(results, thresholds)

    assert (gate.name, gate.ok, gate.detail) == ("cuj_money", False, "2/3 trials")


def test_consistency_keeps_one_flaky_journey_from_hiding_behind_a_green_one() -> None:
    thresholds = Thresholds(
        pass_rates={"cuj_info": 0.8}, judge_averages={}, consistency=Consistency(min_trials_passing={"cuj_info": 2})
    )
    flaky = [_trial("flaky", "cuj_info", n, n == 1) for n in (1, 2, 3)]
    green = [_trial(f"green-{i}", "cuj_info", n, True) for i in range(8) for n in (1, 2, 3)]

    rate, consistency = cuj_gates(flaky + green, thresholds)

    assert rate.ok  # 25 of 27 trials is above 0.8 ...
    assert not consistency.ok  # ... but one journey passed one trial of three.


def _stalled_scenario(**overrides: Any) -> Scenario:
    steps = [{"tool": "ask_payments"}, {"tool": "prepare_transfer"}, {"tool": "execute_transfer", "outcome": "paused"}]
    return _scenario(trajectory=steps, **overrides)


def _output(*delegated: ObservedCall, thread: str = "t", trace_gap: str = "") -> LiveOutput:
    handoff = [
        {"type": "TOOL_CALL_START", "toolCallId": "a", "toolCallName": "ask_payments"},
        {"type": "TOOL_CALL_RESULT", "toolCallId": "a", "messageId": "m", "content": ""},
    ]
    calls = [ObservedCall("ask_payments", delegated=True), *delegated]
    return LiveOutput([RunTrace(handoff)], delegated=calls, thread_id=thread, trace_gap=trace_gap)


def _refused(retry_after: int | None = None) -> LiveOutput:
    return _output(ObservedCall("prepare_transfer", outcome="error:rate_limited", retry_after_seconds=retry_after))


async def _no_restore(_account: str, _balance: Decimal) -> None:
    return None


STARTING = {"acc-juan-ars": Decimal("486750.25")}


async def test_a_trial_the_gateway_rate_limited_runs_again_and_keeps_the_discarded_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    outputs = iter([_refused(), _refused(), _output(thread="third")])

    async def attempt(_scenario: Scenario, _reply: object) -> LiveOutput:
        return next(outputs)

    monkeypatch.setattr("evals.cuj_runner.run_attempt", attempt)
    monkeypatch.setattr("evals.cuj_runner.restore_balance", _no_restore)
    monkeypatch.setattr("evals.cuj_retry.RATE_LIMIT_WAIT_SECONDS", 0.0)

    output = await run_trial(_stalled_scenario(), None, STARTING)

    assert output.attempts == 3
    assert output.thread_id == "third"
    assert [a.verdict for a in output.discarded] == ["rate limited at prepare_transfer after 1 calls"] * 2
    assert output.discarded[0].calls == ["ask_payments:result", "prepare_transfer:error:rate_limited"]
    assert 0 < output.start_ns <= output.end_ns


async def test_an_attempt_with_a_forbidden_call_and_then_a_rate_limit_fails_and_is_not_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts = 0

    async def attempt(_scenario: Scenario, _reply: object) -> LiveOutput:
        nonlocal attempts
        attempts += 1
        return _output(
            ObservedCall("list_beneficiaries"), ObservedCall("prepare_transfer", outcome="error:rate_limited")
        )

    monkeypatch.setattr("evals.cuj_runner.run_attempt", attempt)
    monkeypatch.setattr("evals.cuj_runner.restore_balance", _no_restore)
    monkeypatch.setattr("evals.cuj_retry.RATE_LIMIT_WAIT_SECONDS", 0.0)

    output = await run_trial(_stalled_scenario(forbid=["list_beneficiaries"]), None, STARTING)

    assert (attempts, output.attempts, output.discarded) == (1, 1, [])


GAP = "only 1 of 2 runs reached Phoenix for the thread"


def _complete(thread: str) -> LiveOutput:
    steps = [ObservedCall("prepare_transfer"), ObservedCall("execute_transfer", outcome="paused", delegated=True)]
    return _output(*steps, thread=thread)


def _patch_attempts(monkeypatch: pytest.MonkeyPatch, outputs: list[LiveOutput]) -> list[int]:
    ran: list[int] = []
    queue = iter(outputs)

    async def attempt(_scenario: Scenario, _reply: object) -> LiveOutput:
        ran.append(1)
        return next(queue)

    monkeypatch.setattr("evals.cuj_runner.run_attempt", attempt)
    monkeypatch.setattr("evals.cuj_runner.restore_balance", _no_restore)
    return ran


async def test_missing_traces_with_a_clean_visible_part_rerun_once_and_pass(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_attempts(monkeypatch, [_output(thread="late", trace_gap=GAP), _complete("fresh")])

    output = await run_trial(_stalled_scenario(), None, STARTING)

    assert (output.attempts, output.thread_id, output.trace_gap) == (2, "fresh", "")
    [inconclusive] = output.discarded
    assert inconclusive.thread_id == "late"
    assert inconclusive.verdict == f"inconclusive: {GAP}"


async def test_a_second_trace_miss_fails_the_trial_with_a_note(monkeypatch: pytest.MonkeyPatch) -> None:
    ran = _patch_attempts(monkeypatch, [_output(thread="a", trace_gap=GAP), _output(thread="b", trace_gap=GAP)])

    output = await run_trial(_stalled_scenario(), None, STARTING)

    assert (len(ran), output.attempts, output.trace_gap) == (2, 2, GAP)
    assert [a.thread_id for a in output.discarded] == ["a"]


async def test_a_visible_forbidden_call_with_traces_missing_fails_without_a_rerun(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gap = _output(ObservedCall("execute_transfer"), thread="a", trace_gap=GAP)
    ran = _patch_attempts(monkeypatch, [gap])

    output = await run_trial(_stalled_scenario(forbid=["execute_transfer:result"]), None, STARTING)

    assert (len(ran), output.attempts, output.discarded) == (1, 1, [])


def test_a_rate_limit_after_the_steps_are_done_is_not_a_stall() -> None:
    scenario = _scenario(trajectory=[{"tool": "ask_payments"}], allow=["prepare_transfer:error:rate_limited"])

    assert rate_limit_stall(scenario, _refused()) is None


async def test_the_wait_is_the_gateways_retry_after_capped_at_its_window(monkeypatch: pytest.MonkeyPatch) -> None:
    waits: list[float] = []
    outputs = iter([_refused(retry_after=42), _refused(retry_after=9999), _output()])

    async def attempt(_scenario: Scenario, _reply: object) -> LiveOutput:
        return next(outputs)

    async def sleep(seconds: float) -> None:
        waits.append(seconds)

    monkeypatch.setattr("evals.cuj_runner.run_attempt", attempt)
    monkeypatch.setattr("evals.cuj_runner.restore_balance", _no_restore)
    monkeypatch.setattr("evals.cuj_runner.asyncio.sleep", sleep)

    await run_trial(_stalled_scenario(), None, STARTING)

    assert waits == [42.0, 600.0]


async def test_a_trial_that_stays_rate_limited_is_returned_to_fail_not_looped_forever(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def attempt(_scenario: Scenario, _reply: object) -> LiveOutput:
        return _refused()

    monkeypatch.setattr("evals.cuj_runner.run_attempt", attempt)
    monkeypatch.setattr("evals.cuj_runner.restore_balance", _no_restore)
    monkeypatch.setattr("evals.cuj_retry.RATE_LIMIT_WAIT_SECONDS", 0.0)
    monkeypatch.setattr("evals.cuj_runner.RATE_LIMIT_RETRIES", 2)

    output = await run_trial(_stalled_scenario(), None, STARTING)

    assert output.attempts == 3
    assert len(output.discarded) == 2
    assert output.calls[-1].outcome == "error:rate_limited"


async def test_every_trial_starts_from_the_balance_the_run_began_with(monkeypatch: pytest.MonkeyPatch) -> None:
    restored: list[tuple[str, Decimal]] = []

    async def restore(account: str, balance: Decimal) -> None:
        restored.append((account, balance))

    async def attempt(_scenario: Scenario, _reply: object) -> LiveOutput:
        return _output()

    monkeypatch.setattr("evals.cuj_runner.run_attempt", attempt)
    monkeypatch.setattr("evals.cuj_runner.restore_balance", restore)

    await run_trial(_stalled_scenario(), None, STARTING)
    await run_trial(_stalled_scenario(), None, STARTING)

    assert restored == [("acc-juan-ars", Decimal("486750.25"))] * 2


async def test_the_step_up_is_made_against_the_card_of_the_interrupted_draft() -> None:
    bff = FakeBff([_paused(draft="drf_1", cards=["drf_1", "drf_2"]), _text("Enviada")], step_ups=[200])

    await play(bff.session(), _scenario(), None)

    resume = bff.run_bodies[1]["resume"][0]
    assert resume["payload"]["editedArgs"]["draft_id"] == "drf_1"
    assert bff.step_up_drafts == ["drf_1"]


async def test_the_confirm_card_shown_a_turn_before_the_approval_is_found() -> None:
    asked = [_card("drf_1"), *_text("¿Confirmás?")]
    bff = FakeBff([asked, _paused(draft="drf_1", cards=[]), _text("Enviada")], step_ups=[200])

    journey = await play(bff.session(), _scenario(then=["sí"]), None)

    assert journey.notes == []
    assert bff.step_up_drafts == ["drf_1"]
    assert len(journey.traces) == 3


async def test_an_interrupt_with_no_matching_card_is_noted_and_nothing_is_stepped_up() -> None:
    bff = FakeBff([_paused(draft="drf_9", cards=["drf_1"])])

    journey = await play(bff.session(), _scenario(), None)

    assert [n.text for n in journey.notes] == ["no confirm card for the interrupted draft 'drf_9'"]
    assert bff.step_up_pins == []
    assert len(journey.traces) == 1


async def test_a_group_with_no_threshold_fails_its_gate() -> None:
    thresholds = Thresholds(pass_rates={"cuj_money": 1.0}, judge_averages={})

    [gate] = cuj_gates([_trial("a", "cuj_unlisted", 1, True)], thresholds)

    assert not gate.ok
    assert "no pass_rates entry" in gate.detail


async def test_a_run_with_no_gates_does_not_exit_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("evals.cuj_runner.load_scenarios", lambda: [_scenario()])
    monkeypatch.setattr("evals.cuj_runner.Settings", lambda: type("S", (), {"guard_model": "test"})())
    monkeypatch.setattr("evals.cuj_runner.read_ledger", _ledger)
    monkeypatch.setattr("evals.cuj_runner.run_scenario", _no_results)
    monkeypatch.setattr("evals.cuj_runner.emit_trials", lambda *_: None)
    monkeypatch.setattr("evals.cuj_runner.token_bill", lambda *_: {})

    assert await main(None, None, None) == 1


async def _ledger(_account: str) -> Any:
    return type("L", (), {"balance": Decimal("1")})()


async def _no_results(*_args: Any) -> list[TrialResult]:
    return []


def test_discarded_attempts_are_part_of_a_trials_record() -> None:
    attempt = DiscardedAttempt("t1", "rate limited at prepare_transfer after 1 calls", ["ask_payments:result"])

    assert attempt.thread_id == "t1"


async def _run_with(monkeypatch: pytest.MonkeyPatch, scenario: Scenario, output: LiveOutput) -> tuple[int, LiveOutput]:
    attempts = 0

    async def attempt(_scenario: Scenario, _reply: object) -> LiveOutput:
        nonlocal attempts
        attempts += 1
        return output

    monkeypatch.setattr("evals.cuj_runner.run_attempt", attempt)
    monkeypatch.setattr("evals.cuj_runner.restore_balance", _no_restore)
    monkeypatch.setattr("evals.cuj_retry.RATE_LIMIT_WAIT_SECONDS", 0.0)
    trial = await run_trial(scenario, None, STARTING)
    return attempts, trial


async def test_a_bare_forbid_on_a_rate_limited_call_fails_and_is_not_retried(monkeypatch: pytest.MonkeyPatch) -> None:
    refused_execute = _output(
        ObservedCall("prepare_transfer"), ObservedCall("execute_transfer", outcome="error:rate_limited")
    )
    scenario = _stalled_scenario(forbid=["execute_transfer"])

    assert rate_limit_stall(scenario, refused_execute) is None
    _, output = await _run_with(monkeypatch, scenario, refused_execute)
    assert (output.attempts, output.discarded) == (1, [])


async def test_a_rate_limited_execute_is_a_stall_when_only_a_result_is_forbidden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    refused_execute = _output(
        ObservedCall("prepare_transfer"), ObservedCall("execute_transfer", outcome="error:rate_limited")
    )
    scenario = _stalled_scenario(forbid=["execute_transfer:result"])

    assert rate_limit_stall(scenario, refused_execute) is not None
    attempts, _ = await _run_with(monkeypatch, scenario, refused_execute)
    assert attempts == RATE_LIMIT_RETRIES + 1  # Retried until the budget ran out, never counted as a verdict.


def test_a_harness_note_beside_a_rate_limit_keeps_the_attempt_as_the_verdict() -> None:
    attempt = _refused()
    attempt.notes = [Note("no confirm card for the interrupted draft 'drf_1'")]

    assert rate_limit_stall(_stalled_scenario(), attempt) is None


def test_running_out_of_turns_beside_a_rate_limit_is_still_a_stall() -> None:
    attempt = _refused()
    attempt.notes = [Note("ran out of turns (6) before the plan ended", OUT_OF_TURNS)]

    assert rate_limit_stall(_stalled_scenario(), attempt) is not None


def test_a_note_a_stall_does_not_cause_beside_out_of_turns_keeps_the_attempt_as_the_verdict() -> None:
    attempt = _refused()
    attempt.notes = [
        Note("ran out of turns (6) before the plan ended", OUT_OF_TURNS),
        Note("step-up refused with the right PIN: 429 {}", "step_up_refused"),
    ]

    assert rate_limit_stall(_stalled_scenario(), attempt) is None


async def test_a_forbidden_call_after_a_rate_limited_prepare_fails_and_is_not_retried(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempt = _output(
        ObservedCall("prepare_transfer", outcome="error:rate_limited"), ObservedCall("list_beneficiaries")
    )
    scenario = _stalled_scenario(forbid=["list_beneficiaries"])

    assert rate_limit_stall(scenario, attempt) is None
    _, output = await _run_with(monkeypatch, scenario, attempt)
    assert (output.attempts, output.discarded) == (1, [])


def test_a_rate_limited_call_the_journey_never_names_is_not_a_stall() -> None:
    attempt = _output(ObservedCall("send_money", outcome="error:rate_limited"))

    assert rate_limit_stall(_stalled_scenario(), attempt) is None


def test_fewer_trials_than_the_consistency_minimum_clamp_it_and_say_so() -> None:
    thresholds = Thresholds(
        pass_rates={"cuj_money": 1.0}, judge_averages={}, consistency=Consistency(min_trials_passing={"cuj_money": 2})
    )

    _, consistency = cuj_gates([_trial("a", "cuj_money", 1, True)], thresholds)

    assert consistency.ok
    assert "WEAKENED" in consistency.detail
    _, failing = cuj_gates([_trial("a", "cuj_money", 1, False)], thresholds)
    assert not failing.ok


def test_the_trial_span_carries_the_threads_of_its_discarded_attempts() -> None:
    result = TrialResult("cuj-t", "cuj_money", 1, True, {}, 1.0, 2, "kept", "", [], "scripted", 3, 0, 1, 2)
    result = dataclasses.replace(result, discarded=[DiscardedAttempt("a", "v", []), DiscardedAttempt("b", "v", [])])

    assert _trial_span(result).discarded_threads == ("a", "b")


def test_the_calls_are_computed_with_the_delegated_calls_attached() -> None:
    output = _output(ObservedCall("prepare_transfer"))
    assert [c.name for c in output.calls] == ["ask_payments", "prepare_transfer"]

    output.delegated = [ObservedCall("ask_payments", delegated=True)]
    output.refresh_calls()

    assert [c.name for c in output.calls] == ["ask_payments"]


def _unpaired_prepare_output() -> LiveOutput:
    return _output(
        ObservedCall("prepare_transfer", unpaired=True), thread="a", trace_gap="1 traces could not be paired"
    )


def test_an_unpaired_prepare_is_not_judged_on_its_arguments() -> None:
    scenario = _scenario(
        trajectory=[{"tool": "ask_payments"}, {"tool": "prepare_transfer", "args": {"amount": "1.00"}}]
    )

    assert trace_gap_verdict(scenario, _unpaired_prepare_output()) == "inconclusive: 1 traces could not be paired"


def test_a_paired_prepare_with_other_arguments_is_still_unexpected() -> None:
    scenario = _scenario(
        trajectory=[{"tool": "ask_payments"}, {"tool": "prepare_transfer", "args": {"amount": "1.00"}}]
    )
    wrong = _output(ObservedCall("prepare_transfer", {"amount": "9.00"}), trace_gap=GAP)

    assert trace_gap_verdict(scenario, wrong) is None


async def test_a_pairing_failure_fails_the_trial_without_a_rerun(monkeypatch: pytest.MonkeyPatch) -> None:
    note = "run-id mismatch: traces carry bot.run_id ['x'], runs have ['y']"
    failed = _output(thread="a", trace_gap=note)
    failed.pairing_failed = True
    ran = _patch_attempts(monkeypatch, [failed])

    output = await run_trial(_stalled_scenario(), None, STARTING)

    assert (len(ran), output.attempts, output.discarded, output.trace_gap) == (1, 1, [], note)
