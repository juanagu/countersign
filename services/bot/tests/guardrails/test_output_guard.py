import logging
from typing import Any

import pytest
from ag_ui.core import (
    ActivitySnapshotEvent,
    BaseEvent,
    EventType,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    RunErrorEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)

from app.guardrails.grounding import Evidence
from app.guardrails.output_guard import (
    PII_METRIC,
    RUN_ERROR_MESSAGE,
    RUN_ERROR_METRIC,
    SURFACE_FALLBACK,
    UNGROUNDED_FALLBACK,
    OutputGuard,
    split_sentences,
)

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


def test_an_asterisk_mask_inside_bold_reaches_the_client_as_bullets(evidence: Evidence) -> None:
    line = "- **Cuenta corriente en pesos (****4521):** $ 1.254.300,50\n"
    out = _run(OutputGuard(evidence), _text_events(line[:20], line[20:]))
    assert _text(out) == "- **Cuenta corriente en pesos (••••4521):** $ 1.254.300,50\n"


def test_bold_figures_keep_their_asterisks(evidence: Evidence) -> None:
    assert _text(_run(OutputGuard(evidence), _text_events("Tenés **$ 1.254.300,50**."))) == "Tenés **$ 1.254.300,50**."


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


def _tool_call(call_id: str, name: str) -> list[BaseEvent]:
    return [
        ToolCallStartEvent(type=EventType.TOOL_CALL_START, tool_call_id=call_id, tool_call_name=name),
        ToolCallArgsEvent(type=EventType.TOOL_CALL_ARGS, tool_call_id=call_id, delta='{"children": []}'),
        ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=call_id),
        ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT, message_id=f"r-{call_id}", tool_call_id=call_id, content="ok"
        ),
    ]


def test_the_raw_render_ui_call_never_leaves_but_other_tool_calls_do(evidence: Evidence) -> None:
    out = _run(OutputGuard(evidence), [*_tool_call("ui", "render_ui"), *_tool_call("tx", "execute_transfer")])
    assert {getattr(e, "tool_call_id", None) for e in out} == {"tx"}
    assert [e.type for e in out] == [
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_ARGS,
        EventType.TOOL_CALL_END,
        EventType.TOOL_CALL_RESULT,
    ]


def test_reasoning_never_leaves_the_bot(evidence: Evidence) -> None:
    reasoning: list[BaseEvent] = [
        ReasoningStartEvent(type=EventType.REASONING_START, message_id="t"),
        ReasoningMessageStartEvent(type=EventType.REASONING_MESSAGE_START, message_id="t", role="reasoning"),
        ReasoningMessageContentEvent(type=EventType.REASONING_MESSAGE_CONTENT, message_id="t", delta="saldo 999.999"),
        ReasoningMessageEndEvent(type=EventType.REASONING_MESSAGE_END, message_id="t"),
        ReasoningEndEvent(type=EventType.REASONING_END, message_id="t"),
    ]
    assert _run(OutputGuard(evidence), reasoning) == []


def _components_surface(*components: dict[str, Any]) -> ActivitySnapshotEvent:
    update = {"surfaceId": "s", "components": list(components)}
    content: dict[str, Any] = {"a2ui_operations": [{"version": "v0.9", "updateComponents": update}]}
    return ActivitySnapshotEvent(
        type=EventType.ACTIVITY_SNAPSHOT, message_id="a2", activity_type="a2ui-surface", content=content
    )


def _surface_strings(event: BaseEvent) -> str:
    assert isinstance(event, ActivitySnapshotEvent)
    return str(event.content)


def test_pii_inside_any_surface_component_is_masked_and_logged(
    evidence: Evidence, caplog: pytest.LogCaptureFixture
) -> None:
    surface = _components_surface(
        {"id": "c0", "component": "Text", "text": "Escribinos a ana@example.com"},
        {"id": "c1", "component": "List", "items": [{"label": "Teléfono", "value": "11 4567-8901"}]},
        {"id": "c2", "component": "KeyValueList", "items": [{"key": "Mail", "value": "bo@example.com"}]},
        {"id": "c3", "component": "Table", "rows": [["Contacto", "ce@example.com"]]},
        {"id": "c4", "component": "Citation", "title": "Ayuda", "snippet": "o a di@example.com", "docId": "kb-1"},
    )
    with caplog.at_level(logging.WARNING):
        out = _run(OutputGuard(evidence), [surface])
    assert len(out) == 1
    shown = _surface_strings(out[0])
    assert "@example.com" not in shown and "4567-8901" not in shown
    assert shown.count("[email]") == 4 and "[teléfono]" in shown
    assert "'docId': 'kb-1'" in shown and "'id': 'c4'" in shown
    assert any(getattr(r, "metric", None) == PII_METRIC for r in caplog.records)


def test_a_surface_without_pii_is_the_same_event(evidence: Evidence) -> None:
    surface = _components_surface({"id": "c0", "component": "Text", "text": "Hola"})
    assert _run(OutputGuard(evidence), [surface]) == [surface]


def test_a_run_error_reaches_the_client_as_a_safe_message_and_is_logged_redacted(
    evidence: Evidence, caplog: pytest.LogCaptureFixture
) -> None:
    raw = "POST http://idp:3000/token failed: 400 {'error': 'invalid_grant'} for ana@example.com"
    error = RunErrorEvent(type=EventType.RUN_ERROR, message=raw, code="model_error")
    with caplog.at_level(logging.ERROR):
        out = _run(OutputGuard(evidence), [error])
    assert len(out) == 1 and isinstance(out[0], RunErrorEvent)
    assert out[0].message == RUN_ERROR_MESSAGE and out[0].code == "model_error"
    logged = [r for r in caplog.records if getattr(r, "metric", None) == RUN_ERROR_METRIC]
    assert len(logged) == 1
    assert "invalid_grant" in logged[0].error_message and "ana@example.com" not in logged[0].error_message
    assert logged[0].error_code == "model_error"


def test_a_run_error_without_a_code_keeps_none(evidence: Evidence) -> None:
    out = _run(OutputGuard(evidence), [RunErrorEvent(type=EventType.RUN_ERROR, message="boom")])
    assert isinstance(out[0], RunErrorEvent) and out[0].code is None and out[0].message == RUN_ERROR_MESSAGE
