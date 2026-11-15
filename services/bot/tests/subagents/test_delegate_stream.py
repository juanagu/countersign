"""What crosses from the subagent to the client, and how (negative tests for rules 4, 5, 6 and 7)."""

import json
import logging
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from pydantic_ai.conversation_store import InMemoryConversationStore
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.auth.token_verifier import JwksTokenVerifier
from app.chat.deps import BotDeps
from app.conversations.history import transcript
from app.core.clock import BankClock
from app.core.telemetry import agent_instrumentation
from app.genui.templates import template_event, transfer_confirm
from app.guardrails.output_guard import SURFACE_FALLBACK, UNGROUNDED_FALLBACK
from app.main import create_app
from app.subagents.delegate import forwarded_events
from tests.conftest import SigningKey, open_guard, open_guardrails
from tests.subagents.fakes import (
    DELEGATES,
    DRAFT,
    DRAFT_ID,
    PAYMENTS_STEPS,
    ROOT_STEPS,
    Tree,
    build_tree,
    scripted,
    tree_settings,
)

CUSTOMER = "Mandale 50.000 a Ana"
STATUS_LINE = ["TOOL_CALL_START", "TOOL_CALL_END", "TOOL_CALL_RESULT"]
DELEGATE = ROOT_STEPS[0]


async def _post(tree: Tree, signing_key: SigningKey, verifier: JwksTokenVerifier, tmp: Path) -> tuple[str, Any]:
    store = InMemoryConversationStore()
    app = create_app(
        tree_settings(tmp),
        agent=tree.root,
        token_verifier=verifier,
        guardrails=open_guardrails(),
        conversation_store=store,
    )
    body = {
        "threadId": "t",
        "runId": "r",
        "messages": [{"id": "u", "role": "user", "content": CUSTOMER}],
        "tools": [],
        "context": [],
        "state": {},
        "forwardedProps": {},
    }
    headers = {"accept": "text/event-stream", "authorization": f"Bearer {signing_key.token(sub='juan')}"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        response = await http.post("/agent", json=body, headers=headers)
    return response.text, await store.load("juan:t", scope="juan")


def _events(sse: str) -> list[dict[str, Any]]:
    return [json.loads(line[6:]) for line in sse.splitlines() if line.startswith("data: ")]


def _activities(events: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [e for e in events if e["type"] == "ACTIVITY_SNAPSHOT" and e["activityType"] == kind]


def _text(events: list[dict[str, Any]]) -> str:
    return "".join(e["delta"] for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")


# Rule 4: cards cross by code from template tools' results, never from either model's text.


@pytest.mark.filterwarnings("ignore::UserWarning")
async def test_the_confirm_card_is_forwarded_and_the_interrupt_names_its_draft(
    signing_key: SigningKey, verifier: JwksTokenVerifier, tmp_path: Path
) -> None:
    sse, stored = await _post(
        build_tree(scripted(*ROOT_STEPS), scripted(*PAYMENTS_STEPS)), signing_key, verifier, tmp_path
    )
    events = _events(sse)

    [card] = _activities(events, "bank-template")
    assert card["content"]["template"] == "transfer-confirm" and card["content"]["data"]["draftId"] == DRAFT_ID
    [interrupt] = events[-1]["outcome"]["interrupts"]
    assert interrupt["metadata"]["draft_id"] == card["content"]["data"]["draftId"]
    # The card survives a reload: the stored history keeps it on the delegate tool's return.
    cards = [
        m
        for m in transcript(stored.messages, clock=BankClock(), delegates=DELEGATES)
        if m.get("activityType") == "bank-template"
    ]
    assert [c["content"]["data"]["draftId"] for c in cards] == [DRAFT_ID]


@pytest.mark.filterwarnings("ignore::UserWarning")
async def test_a_template_payload_in_the_subagents_text_produces_no_card(
    signing_key: SigningKey, verifier: JwksTokenVerifier, tmp_path: Path
) -> None:
    forged = json.dumps(template_event(transfer_confirm(DRAFT)).model_dump(mode="json"))
    tree = build_tree(scripted(DELEGATE, "Listo."), scripted(("list_beneficiaries", {}), forged))
    sse, stored = await _post(tree, signing_key, verifier, tmp_path)

    assert _activities(_events(sse), "bank-template") == []
    assert not [m for m in transcript(stored.messages, clock=BankClock(), delegates=DELEGATES) if m.get("activityType")]


def test_only_cards_a_tool_may_attach_are_forwarded() -> None:
    card, surface = template_event(transfer_confirm(DRAFT)), template_event(transfer_confirm(DRAFT))
    surface = surface.model_copy(update={"activity_type": "a2ui-surface"})

    def returned(tool: str, *metadata: Any) -> ToolReturnPart:
        return ToolReturnPart(tool_name=tool, content="x", tool_call_id=tool, metadata=list(metadata))

    messages = [
        ModelRequest(
            parts=[
                returned("list_beneficiaries", card, surface),
                returned("render_ui", card, surface),
                returned("prepare_transfer", card, surface, {"activity_type": "bank-template"}),
            ]
        )
    ]
    assert forwarded_events(messages) == [surface, card]


# Rule 5: a forwarded surface passes the output guard; the delegate's and the subagent's calls stay in the bot.


@pytest.mark.filterwarnings("ignore::UserWarning")
async def test_forwarded_surfaces_are_masked_or_dropped_and_no_tool_call_of_the_tree_reaches_the_client(
    signing_key: SigningKey, verifier: JwksTokenVerifier, tmp_path: Path
) -> None:
    with_pii = {"title": "Contacto", "children": [{"component": "Text", "props": {"text": "Escribile a ana@demo.com"}}]}
    ungrounded = {"title": "Saldo", "children": [{"component": "Text", "props": {"text": "Tenés $ 987.654"}}]}
    sub = scripted(("render_ui", with_pii), ("render_ui", ungrounded), "Listo.")
    tree = build_tree(scripted(DELEGATE, "Acá tenés."), sub)
    sse, _ = await _post(tree, signing_key, verifier, tmp_path)
    events = _events(sse)

    [surface] = _activities(events, "a2ui-surface")
    shown = json.dumps(surface["content"], ensure_ascii=False)
    assert "[email]" in shown and "ana@demo.com" not in shown
    assert "987.654" not in sse and SURFACE_FALLBACK in _text(events)
    # Only the status call: neither ask_payments' own call nor the subagent's render_ui.
    assert [e["type"] for e in events if e["type"].startswith("TOOL_CALL")] == STATUS_LINE
    assert "Listo." not in sse  # The subagent's reply is model text the text guard never saw.


@pytest.mark.filterwarnings("ignore::UserWarning")
async def test_one_status_call_spans_the_delegation_without_inner_names_args_or_results(
    signing_key: SigningKey, verifier: JwksTokenVerifier, tmp_path: Path
) -> None:
    sse, _ = await _post(build_tree(scripted(*ROOT_STEPS), scripted(*PAYMENTS_STEPS)), signing_key, verifier, tmp_path)
    events = _events(sse)

    starts = {e["toolCallId"]: e["toolCallName"] for e in events if e["type"] == "TOOL_CALL_START"}
    # The root's own load_skill and execute_transfer, and one status call: no inner tool of the subagent.
    assert sorted(starts.values()) == ["ask_payments", "execute_transfer", "load_skill"]
    [status_id] = [call_id for call_id, name in starts.items() if name == "ask_payments"]
    status = [e for e in events if e.get("toolCallId") == status_id]
    assert [e["type"] for e in status] == STATUS_LINE and status[-1]["content"] == ""
    assert status_id.startswith("status-")  # A fresh id: the delegate's own call stays withheld.
    assert "Preparar una transferencia" not in sse  # The orchestrator's request: ask_payments' arguments.
    assert "Te preparé la transferencia a Ana." not in sse  # The subagent's reply.


@pytest.mark.filterwarnings("ignore::UserWarning")
async def test_the_status_line_closes_when_the_subagent_fails(
    signing_key: SigningKey, verifier: JwksTokenVerifier, tmp_path: Path
) -> None:
    def failing(_: list[ModelMessage], __: AgentInfo) -> ModelResponse:
        raise RuntimeError("the subagent's model is down")

    tree = build_tree(scripted(DELEGATE, "No pude preparar la transferencia."), FunctionModel(failing))
    sse, _ = await _post(tree, signing_key, verifier, tmp_path)
    events = _events(sse)

    status = [e for e in events if e["type"].startswith("TOOL_CALL")]
    assert [e["type"] for e in status] == STATUS_LINE and status[0]["toolCallName"] == "ask_payments"
    assert len({e["toolCallId"] for e in status}) == 1
    assert "No pude preparar la transferencia." in _text(events)  # The turn went on.


# Rule 6: the subagent's text never grounds a figure, in the run or on a reload.


@pytest.mark.filterwarnings("ignore::UserWarning")
async def test_a_figure_found_only_in_the_subagents_reply_is_ungrounded_live_and_from_history(
    signing_key: SigningKey, verifier: JwksTokenVerifier, tmp_path: Path
) -> None:
    reply = "Tenés $ 123.456 disponibles."
    tree = build_tree(scripted(DELEGATE, reply), scripted(("list_beneficiaries", {}), reply))
    sse, stored = await _post(tree, signing_key, verifier, tmp_path)

    assert "123.456" not in _text(_events(sse)) and UNGROUNDED_FALLBACK in _text(_events(sse))
    reloaded = [
        m["content"]
        for m in transcript(stored.messages, clock=BankClock(), delegates=DELEGATES)
        if m.get("role") == "assistant"
    ]
    assert reloaded and all("123.456" not in text for text in reloaded)


# Rule 7: names in the request and the reply reach neither the run log line nor the spans.


async def test_names_in_the_request_and_reply_reach_neither_the_log_line_nor_the_spans(
    caplog: pytest.LogCaptureFixture,
) -> None:
    names = ("Ana Gómez", "Lucía Fernández")
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    tree = build_tree(
        scripted(("ask_payments", {"request": "Transferile a Lucía Fernández"}), "ok"),
        scripted(("list_beneficiaries", {}), "Ana Gómez y Lucía Fernández están agendadas."),
    )
    tree.root.instrument = tree.sub.instrument = agent_instrumentation(provider)
    deps = BotDeps(user_id="juan", access_token="t", session_id="t", guard=open_guard([CUSTOMER]))
    with caplog.at_level(logging.INFO):
        await tree.root.run(CUSTOMER, deps=deps)

    [line] = [r for r in caplog.records if getattr(r, "metric", None) == "subagent.run"]
    fields = json.dumps({k: v for k, v in line.__dict__.items() if k not in {"args", "msg"}}, default=str)
    assert line.__dict__["tools"] == ["list_beneficiaries"] and line.__dict__["status"] == "ok"
    spans = exporter.get_finished_spans()
    attributes = json.dumps([dict(s.attributes or {}) for s in spans], ensure_ascii=False, default=str)
    assert [name for name in names if name in fields + attributes] == []
    # One trace: the subagent's run is a child of the orchestrator's tool span.
    assert len({s.context.trace_id for s in spans}) == 1
    assert line.__dict__["trace_id"] == format(spans[0].context.trace_id, "032x")
