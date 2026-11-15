"""The journey loop on a fake BFF: the simulated customer sees only text, the interrupt policy is answered by code
(approve, cancel, wrong PIN then right, expiry), and the gates count trials."""

import json
from typing import Any

import httpx
import pytest

from evals.agui_client import RUN_PATH, STEP_UP_PATH, BffSession, RunTrace
from evals.calls import ObservedCall
from evals.cuj import Scenario
from evals.cuj_runner import TrialResult, cuj_gates, play, run_trial
from evals.cuj_user import Turn, is_end
from evals.live import LiveOutput
from evals.thresholds import Consistency, Thresholds

CARD = {
    "type": "ACTIVITY_SNAPSHOT",
    "activityType": "bank-template",
    "content": {
        "template": "transfer-confirm",
        "data": {"draftId": "drf_1", "amount": "50000.00", "currency": "ARS", "beneficiaryId": "ben-juan-ana"},
    },
}


def _text(text: str) -> list[dict[str, Any]]:
    return [
        {"type": "TEXT_MESSAGE_START", "messageId": "m"},
        {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": text},
        {"type": "TEXT_MESSAGE_END", "messageId": "m"},
        {"type": "RUN_FINISHED", "outcome": {"type": "success"}},
    ]


def _paused() -> list[dict[str, Any]]:
    interrupt = {"id": "int-x", "toolCallId": "x"}
    return [
        CARD,
        {"type": "TOOL_CALL_START", "toolCallId": "x", "toolCallName": "execute_transfer"},
        {"type": "RUN_FINISHED", "outcome": {"type": "interrupt", "interrupts": [interrupt]}},
    ]


class FakeBff:
    """Serves each run and each step-up from a queue, and records what the client sent."""

    def __init__(self, runs: list[list[dict[str, Any]]], step_ups: list[int] | None = None) -> None:
        self.runs, self.step_ups = list(runs), list(step_ups or [])
        self.run_bodies: list[dict[str, Any]] = []
        self.step_up_pins: list[str] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        if request.url.path.endswith(STEP_UP_PATH):
            self.step_up_pins.append(body["pin"])
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
    assert journey.notes == ["ran out of turns (2) before the plan ended"]


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

    assert journey.notes == ["an interrupt the scenario has no on_interrupt policy for"]
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

    assert journey.notes[0].startswith("step-up refused with the right PIN: 429")


@pytest.mark.parametrize(("message", "ends"), [("FIN", True), (" fin. ", True), ("FINAL", False), ("hola", False)])
def test_the_end_token(message: str, ends: bool) -> None:
    assert is_end(message) is ends


def _trial(cuj_id: str, group: str, trial: int, passed: bool) -> TrialResult:
    return TrialResult(cuj_id, group, trial, passed, {}, 0.0, 1, "t", "", [], "scripted", 1, 0, 0)


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


def _refused() -> LiveOutput:
    handoff = [
        {"type": "TOOL_CALL_START", "toolCallId": "a", "toolCallName": "ask_payments"},
        {"type": "TOOL_CALL_RESULT", "toolCallId": "a", "messageId": "m", "content": ""},
    ]
    delegated = [
        ObservedCall("ask_payments", delegated=True),
        ObservedCall("prepare_transfer", outcome="error:rate_limited", delegated=True),
    ]
    return LiveOutput([RunTrace(handoff)], delegated=delegated)


async def test_a_trial_the_gateway_rate_limited_runs_again_after_the_window(monkeypatch: pytest.MonkeyPatch) -> None:
    outputs = iter([_refused(), _refused(), LiveOutput([])])

    async def attempt(_scenario: Scenario, _reply: object) -> LiveOutput:
        return next(outputs)

    monkeypatch.setattr("evals.cuj_runner.run_attempt", attempt)
    monkeypatch.setattr("evals.cuj_runner.RATE_LIMIT_WAIT_SECONDS", 0.0)

    output = await run_trial(_scenario(), None)

    assert output.attempts == 3
    assert output.delegated == []  # The third attempt's output.


async def test_a_trial_that_stays_rate_limited_is_returned_to_fail_not_looped_forever(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def attempt(_scenario: Scenario, _reply: object) -> LiveOutput:
        return _refused()

    monkeypatch.setattr("evals.cuj_runner.run_attempt", attempt)
    monkeypatch.setattr("evals.cuj_runner.RATE_LIMIT_WAIT_SECONDS", 0.0)
    monkeypatch.setattr("evals.cuj_runner.RATE_LIMIT_RETRIES", 2)

    output = await run_trial(_scenario(), None)

    assert output.attempts == 3
    assert output.calls[-1].outcome == "error:rate_limited"
