"""A reload past the replay window rebuilds the thread from stored history: text plus the server-template cards."""

from datetime import UTC, datetime
from typing import Any
from zoneinfo import ZoneInfo

from ag_ui.core import ActivitySnapshotEvent, EventType
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart, UserPromptPart

from app.conversations.history import transcript
from app.core.clock import BankClock
from app.genui.a2ui import ACTIVITY_TYPE as SURFACE_ACTIVITY
from app.genui.templates import ACTIVITY_TYPE as TEMPLATE_ACTIVITY
from app.guardrails.output_guard import UNGROUNDED_FALLBACK

CLOCK = BankClock()
RECEIPT = {"template": "transfer-receipt", "version": 1, "data": {"reference": "BD-1"}}


def _event(activity_type: str, message_id: str, content: dict[str, Any]) -> ActivitySnapshotEvent:
    return ActivitySnapshotEvent(
        type=EventType.ACTIVITY_SNAPSHOT, message_id=message_id, activity_type=activity_type, content=content
    )


def _turn(tool: str, metadata: list[Any], content: Any = "ok") -> list[ModelRequest | ModelResponse]:
    return [
        ModelResponse(parts=[ToolCallPart(tool_name=tool, args={}, tool_call_id=f"c-{tool}")]),
        ModelRequest(
            parts=[ToolReturnPart(tool_name=tool, content=content, tool_call_id=f"c-{tool}", metadata=metadata)]
        ),
    ]


ACCOUNTS = {"untrusted_data": [{"number": "****7810", "balance": 486750.25}], "note": "data"}


def test_the_receipt_card_comes_back_in_place_and_tool_traffic_does_not() -> None:
    messages = [
        ModelRequest(parts=[UserPromptPart(content="Mandale 1.000 a Ana")]),
        *_turn("execute_transfer", [_event(TEMPLATE_ACTIVITY, "card-1", RECEIPT)]),
        ModelResponse(parts=[TextPart(content="Listo.")]),
    ]

    shown = transcript(messages, clock=CLOCK)

    assert [m["role"] for m in shown] == ["user", "activity", "assistant"]
    assert shown[1] == {"id": "card-1", "role": "activity", "activityType": TEMPLATE_ACTIVITY, "content": RECEIPT}
    assert not any("toolCalls" in m or m["role"] == "tool" for m in shown)


def test_a_card_read_back_from_postgres_as_a_dict_comes_back_too() -> None:
    stored = _event(TEMPLATE_ACTIVITY, "card-2", RECEIPT).model_dump()

    shown = transcript(_turn("execute_transfer", [stored]), clock=CLOCK)

    assert [(m["id"], m["content"]) for m in shown] == [("card-2", RECEIPT)]


def test_a_stored_a2ui_surface_is_not_restored_because_the_output_guard_may_have_withheld_it() -> None:
    surface = _event(SURFACE_ACTIVITY, "surface-1", {"operations": []})

    assert transcript(_turn("render_ui", [surface, surface.model_dump()]), clock=CLOCK) == []


def test_an_answer_stored_with_an_asterisk_mask_is_shown_with_bullets() -> None:
    stored = ModelResponse(parts=[TextPart(content="- **Cuenta corriente en pesos (****7810):** $ 486.750,25")])

    [shown] = transcript([*_turn("list_accounts", [], ACCOUNTS), stored], clock=CLOCK)

    assert shown["content"] == "- **Cuenta corriente en pesos (••••7810):** $ 486.750,25"


def test_a_reload_shows_what_the_output_guard_released_not_the_stored_answer() -> None:
    stored = ModelResponse(
        parts=[
            TextPart(
                content="Tu saldo es $ 486.750,25. Además tenés $ 999.999 en un plazo fijo. "
                "Te escribo a ana.perez@example.com."
            )
        ]
    )
    messages = [ModelRequest(parts=[UserPromptPart(content="¿Cuánto tengo?")]), *_turn("list_accounts", [], ACCOUNTS)]

    [_, answer] = transcript([*messages, stored], clock=CLOCK)

    assert answer["content"] == f"Tu saldo es $ 486.750,25. {UNGROUNDED_FALLBACK} Te escribo a [email]."
    assert "999.999" not in answer["content"]
    assert "ana.perez@example.com" not in answer["content"]


def test_a_figure_from_a_later_tool_result_does_not_ground_an_earlier_answer() -> None:
    early = ModelResponse(parts=[TextPart(content="Tenés $ 486.750,25.")])

    [shown, *_] = transcript([early, *_turn("list_accounts", [], ACCOUNTS)], clock=CLOCK)

    assert shown["content"] == UNGROUNDED_FALLBACK


def test_an_answer_is_grounded_on_the_day_in_the_banks_timezone_not_the_default_one() -> None:
    # 01:30 UTC is still the 13th in Buenos Aires (the default zone) but already the 14th in Tokyo.
    answer = ModelResponse(
        parts=[TextPart(content="Hoy es 14/11/2026.")], timestamp=datetime(2026, 11, 14, 1, 30, tzinfo=UTC)
    )
    messages = [ModelRequest(parts=[UserPromptPart(content="¿Qué día es hoy?")]), answer]

    in_tokyo = transcript(messages, clock=BankClock(ZoneInfo("Asia/Tokyo")))
    by_default = transcript(messages, clock=BankClock())

    assert in_tokyo[-1]["content"] == "Hoy es 14/11/2026."
    assert by_default[-1]["content"] == UNGROUNDED_FALLBACK
