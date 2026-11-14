"""The live-suite evaluators and gates fail on what they claim to catch (they gate `make eval`)."""

import json
from datetime import date
from decimal import Decimal
from typing import Any

from pydantic_evals.evaluators import EvaluationReason, EvaluatorContext
from pydantic_evals.otel._errors import SpanTreeRecordingError

from evals.agui_client import RunTrace
from evals.bank_db import Ledger
from evals.golden import build_dataset, month_range
from evals.live import LiveInput, LiveOutput, ResumeCheck
from evals.live_evaluators import AnswersInText, CalledTool, Cites, Contains, SpendingMatches
from evals.run import Gate
from evals.scenario_evaluators import MovedMoneyOnce, ResumedIntact

SPENDING = {"untrusted_data": {"categories": [
    {"category": "vivienda", "currency": "ARS", "total": "380000.00"},
    {"category": "salud", "currency": "ARS", "total": "26983.23"},
]}}  # fmt: skip


def _ctx(output: LiveOutput) -> EvaluatorContext[LiveInput, LiveOutput, dict[str, str]]:
    return EvaluatorContext(
        name="c", inputs=LiveInput(turns=["hola"]), metadata=None, expected_output=None, output=output,
        duration=0.0, _span_tree=SpanTreeRecordingError("n/a"), attributes={}, metrics={},
    )  # fmt: skip


def _surface(*components: dict[str, Any]) -> dict[str, Any]:
    ops = [{"updateComponents": {"components": list(components)}}]
    return {"type": "ACTIVITY_SNAPSHOT", "activityType": "a2ui-surface", "content": {"a2ui_operations": ops}}


def _tool(name: str, args: dict[str, Any], result: Any = "{}") -> list[dict[str, Any]]:
    return [
        {"type": "TOOL_CALL_START", "toolCallId": name, "toolCallName": name},
        {"type": "TOOL_CALL_ARGS", "toolCallId": name, "delta": json.dumps(args)},
        {"type": "TOOL_CALL_RESULT", "toolCallId": name, "messageId": "r", "content": json.dumps(result)},
    ]


def _text(text: str) -> list[dict[str, Any]]:
    start = {"type": "TEXT_MESSAGE_START", "messageId": "m"}
    return [start, {"type": "TEXT_MESSAGE_CONTENT", "messageId": "m", "delta": text}]


def _value(result: bool | EvaluationReason) -> bool:
    return bool(result.value if isinstance(result, EvaluationReason) else result)


def _chart(*values: float, repeated_list: bool = False) -> LiveOutput:
    bars = {"component": "BarChart", "currency": "ARS", "bars": [{"label": "x", "value": v} for v in values]}
    items = {"component": "List", "items": [{"title": "x", "trailing": "$ 380.000,00"}]}
    components = (bars, items) if repeated_list else (bars,)
    return LiveOutput([RunTrace([*_tool("spending_summary", {}, SPENDING), _surface(*components)])])


def test_spending_bars_must_match_the_tool_totals_with_no_list_repeating_them() -> None:
    assert _value(SpendingMatches().evaluate(_ctx(_chart(380000, 26983.23))))
    assert not _value(SpendingMatches().evaluate(_ctx(_chart(380000, 27000))))
    assert not _value(SpendingMatches().evaluate(_ctx(_chart(380000, 26983.23, repeated_list=True))))


def test_the_answer_is_in_the_text_and_never_points_to_a_card() -> None:
    answered = LiveOutput([RunTrace(_text("Cuesta US$ 25 más el 0,5 %."))])
    pointer = LiveOutput([RunTrace(_text("Te dejé el detalle en la tarjeta de arriba."))])
    silent = LiveOutput([RunTrace([_surface({"component": "Text", "text": "US$ 25"})])])
    assert _value(AnswersInText().evaluate(_ctx(answered)))
    assert not _value(AnswersInText().evaluate(_ctx(pointer)))
    assert not _value(AnswersInText().evaluate(_ctx(silent)))


def test_tool_arguments_and_citations_are_checked() -> None:
    output = LiveOutput([RunTrace(_tool("get_balance", {"account_id": "acc-ana-usd"}))])
    assert _value(CalledTool("get_balance", {"account_id": "acc-ana-usd"}).evaluate(_ctx(output)))
    assert not _value(CalledTool("get_balance", {"account_id": "acc-ana-ars"}).evaluate(_ctx(output)))
    cited = LiveOutput([RunTrace([_surface({"component": "Citation", "sources": [{"docId": "comisiones"}]})])])
    assert _value(Cites(("comisiones", "faq")).evaluate(_ctx(cited)))
    assert not _value(Cites(("limites",)).evaluate(_ctx(cited)))


def test_contains_reads_the_text_and_the_cards() -> None:
    on_card = LiveOutput([RunTrace([*_text("Mirá la tarjeta."), _surface({"component": "Text", "text": "US$ 25"})])])
    assert Contains("US$ 25").evaluate(_ctx(on_card))
    assert not Contains("0,5").evaluate(_ctx(on_card))


def _receipt(amount: str = "50000.00", fee: str = "0.00") -> RunTrace:
    card = {"template": "transfer-receipt", "data": {"amount": amount, "fee": fee}}
    return RunTrace([{"type": "ACTIVITY_SNAPSHOT", "activityType": "bank-template", "content": card}])


def test_money_must_move_exactly_once() -> None:
    once = LiveOutput([_receipt()], ledger_change=Ledger(Decimal("-50000.00"), 1, 1))
    twice = LiveOutput([_receipt()], ledger_change=Ledger(Decimal("-100000.00"), 2, 2))
    assert _value(MovedMoneyOnce().evaluate(_ctx(once)))
    assert not _value(MovedMoneyOnce().evaluate(_ctx(twice)))


def _replay(*deltas: str, starts: int = 1) -> RunTrace:
    events = [{"type": "RUN_STARTED"}] * starts + [ev for d in deltas for ev in _text(d)[1:]]
    return RunTrace([{"type": "TEXT_MESSAGE_START", "messageId": "m"}, *events, {"type": "RUN_FINISHED"}])


def test_a_resume_that_loses_or_repeats_text_fails() -> None:
    whole = _replay("Hola. ", "Chau.")
    good = LiveOutput([whole], resume=ResumeCheck(True, "Hola. ", whole, whole))
    lost = LiveOutput([whole], resume=ResumeCheck(True, "Buenas. ", whole, whole))
    doubled = _replay("Hola. ", "Chau.", starts=2)
    repeated = LiveOutput([doubled], resume=ResumeCheck(True, "Hola. ", doubled, doubled))
    assert _value(ResumedIntact().evaluate(_ctx(good)))
    assert not _value(ResumedIntact().evaluate(_ctx(lost)))
    assert not _value(ResumedIntact().evaluate(_ctx(repeated)))


def test_month_ranges_and_dataset_groups() -> None:
    assert month_range(date(2026, 3, 15), 1) == (date(2026, 2, 1), date(2026, 2, 28))
    assert month_range(date(2026, 1, 5), 2) == (date(2025, 11, 1), date(2025, 11, 30))
    groups = {(case.metadata or {}).get("group") for case in build_dataset("test", date(2026, 11, 13)).cases}
    assert groups == {"scenario", "kb_grounding", "tool_selection"}
    assert not Gate("redteam", 0.94, 0.95, "").ok
