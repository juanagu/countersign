from typing import Any

import pytest
from ag_ui.core import (
    ActivitySnapshotEvent,
    BaseEvent,
    EventType,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallStartEvent,
)

from app.guardrails.grounding import Evidence
from app.guardrails.output_guard import SURFACE_FALLBACK, UNGROUNDED_FALLBACK, OutputGuard, split_sentences

MID = "m1"


def _text_events(*deltas: str) -> list[BaseEvent]:
    events: list[BaseEvent] = [TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=MID)]
    events += [TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=MID, delta=d) for d in deltas]
    return [*events, TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=MID)]


def _run(guard: OutputGuard, events: list[BaseEvent]) -> list[BaseEvent]:
    return [out for event in events for out in guard.process(event)]


def _text(events: list[BaseEvent]) -> str:
    return "".join(e.delta for e in events if isinstance(e, TextMessageContentEvent))


@pytest.fixture
def evidence() -> Evidence:
    found = Evidence()
    found.add({"balance": "1254300.50", "number": "****4521"})
    return found


def test_splits_at_sentence_ends_but_not_inside_amounts() -> None:
    assert split_sentences("Tenés $ 1.254.300,50. Y algo") == (["Tenés $ 1.254.300,50. "], "Y algo")
    assert split_sentences("Tenés $ 1.") == ([], "Tenés $ 1.")
    assert split_sentences("- uno\n- dos") == (["- uno\n"], "- dos")


def test_releases_whole_sentences_and_keeps_start_and_end_paired(evidence: Evidence) -> None:
    out = _run(OutputGuard(evidence), _text_events("Tu saldo es $ 1.254", ".300,50. ", "¿Algo más?"))
    types = [e.type for e in out]
    assert types[0] == EventType.TEXT_MESSAGE_START and types[-1] == EventType.TEXT_MESSAGE_END
    assert [e.delta for e in out if isinstance(e, TextMessageContentEvent)] == [
        "Tu saldo es $ 1.254.300,50. ",
        "¿Algo más?",
    ]


def test_an_ungrounded_figure_never_leaves_even_when_split_across_deltas(evidence: Evidence) -> None:
    out = _run(OutputGuard(evidence), _text_events("Hola. Tu saldo es $ 9", "99.", "999,00. Saludos."))
    text = _text(out)
    assert "999" not in text
    assert text == f"Hola. {UNGROUNDED_FALLBACK} Saludos."


def test_a_leaked_card_or_email_is_masked(evidence: Evidence) -> None:
    out = _run(OutputGuard(evidence), _text_events("Tu tarjeta 4532 0151 1283 0366 y ana@example.com."))
    assert _text(out) == "Tu tarjeta [tarjeta] y [email]."


def _surface(value: float) -> ActivitySnapshotEvent:
    update = {"surfaceId": "s", "components": [{"id": "c0", "component": "BarChart", "bars": [{"value": value}]}]}
    content: dict[str, Any] = {"a2ui_operations": [{"version": "v0.9", "updateComponents": update}]}
    return ActivitySnapshotEvent(
        type=EventType.ACTIVITY_SNAPSHOT, message_id="a1", activity_type="a2ui-surface", content=content
    )


def test_a_surface_with_an_ungrounded_number_is_dropped_for_a_text_fallback(evidence: Evidence) -> None:
    out = _run(OutputGuard(evidence), [_surface(777777.0)])
    assert not any(isinstance(e, ActivitySnapshotEvent) for e in out)
    assert _text(out) == SURFACE_FALLBACK
    assert out[0].type == EventType.TEXT_MESSAGE_START


def test_a_grounded_surface_and_a_bank_template_pass_untouched(evidence: Evidence) -> None:
    card = ActivitySnapshotEvent(
        type=EventType.ACTIVITY_SNAPSHOT, message_id="c", activity_type="bank-template", content={"amount": "999.99"}
    )
    other = ToolCallStartEvent(type=EventType.TOOL_CALL_START, tool_call_id="t", tool_call_name="x")
    events: list[BaseEvent] = [_surface(1254300.5), card, other]
    assert _run(OutputGuard(evidence), events) == events
