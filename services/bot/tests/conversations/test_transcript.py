"""A reload past the replay window rebuilds the thread from stored history: text plus the server-template cards."""

from typing import Any

from ag_ui.core import ActivitySnapshotEvent, EventType
from pydantic_ai.messages import ModelRequest, ModelResponse, TextPart, ToolCallPart, ToolReturnPart, UserPromptPart

from app.conversations.history import transcript
from app.genui.a2ui import ACTIVITY_TYPE as SURFACE_ACTIVITY
from app.genui.templates import ACTIVITY_TYPE as TEMPLATE_ACTIVITY

RECEIPT = {"template": "transfer-receipt", "version": 1, "data": {"reference": "BD-1"}}


def _event(activity_type: str, message_id: str, content: dict[str, Any]) -> ActivitySnapshotEvent:
    return ActivitySnapshotEvent(
        type=EventType.ACTIVITY_SNAPSHOT, message_id=message_id, activity_type=activity_type, content=content
    )


def _turn(tool: str, metadata: list[Any]) -> list[ModelRequest | ModelResponse]:
    return [
        ModelResponse(parts=[ToolCallPart(tool_name=tool, args={}, tool_call_id=f"c-{tool}")]),
        ModelRequest(parts=[ToolReturnPart(tool_name=tool, content="ok", tool_call_id=f"c-{tool}", metadata=metadata)]),
    ]


def test_the_receipt_card_comes_back_in_place_and_tool_traffic_does_not() -> None:
    messages = [
        ModelRequest(parts=[UserPromptPart(content="Mandale 1.000 a Ana")]),
        *_turn("execute_transfer", [_event(TEMPLATE_ACTIVITY, "card-1", RECEIPT)]),
        ModelResponse(parts=[TextPart(content="Listo.")]),
    ]

    shown = transcript(messages)

    assert [m["role"] for m in shown] == ["user", "activity", "assistant"]
    assert shown[1] == {"id": "card-1", "role": "activity", "activityType": TEMPLATE_ACTIVITY, "content": RECEIPT}
    assert not any("toolCalls" in m or m["role"] == "tool" for m in shown)


def test_a_card_read_back_from_postgres_as_a_dict_comes_back_too() -> None:
    stored = _event(TEMPLATE_ACTIVITY, "card-2", RECEIPT).model_dump()

    shown = transcript(_turn("execute_transfer", [stored]))

    assert [(m["id"], m["content"]) for m in shown] == [("card-2", RECEIPT)]


def test_a_stored_a2ui_surface_is_not_restored_because_the_output_guard_may_have_withheld_it() -> None:
    surface = _event(SURFACE_ACTIVITY, "surface-1", {"operations": []})

    assert transcript(_turn("render_ui", [surface, surface.model_dump()])) == []
