"""A later turn cannot raise an interrupt on a draft the conversation already decided or replaced (rule 3)."""

import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic_ai import DeferredToolRequests, DeferredToolResults, ToolApproved, ToolDenied
from pydantic_ai.messages import ModelMessage, ToolReturnPart

from app.auth.token_verifier import JwksTokenVerifier
from app.chat.deps import BotDeps
from app.main import create_app
from app.skills.history import skills_loaded_in
from evals.agui_client import fold
from tests.conftest import SigningKey, open_guard, open_guardrails
from tests.subagents.fakes import (
    DELEGATES,
    DRAFT,
    DRAFT_ID,
    PAYMENTS_STEPS,
    ROOT_STEPS,
    FakeGateway,
    build_tree,
    delegated_draft,
    per_turn,
    scripted,
    tree_settings,
)

CUSTOMER = "Mandale 50.000 a Ana"
NEWER_DRAFT_ID = "drf_newer"
DENIAL = {"error": "policy_denied", "reason": "the draft is not this conversation's open draft"}


def _deps(history: Sequence[ModelMessage], *messages: str) -> BotDeps:
    return BotDeps(
        user_id="juan",
        access_token="bot-token-juan",
        loaded_skills=skills_loaded_in(history, delegates=DELEGATES),
        session_id="t",
        guard=open_guard(list(messages)),
    )


async def _firstper_turn(gateway: FakeGateway, answer: ToolApproved | ToolDenied) -> list[ModelMessage]:
    """Prepared by payments, paused on the approval, then approved (a receipt) or denied by the customer."""
    tree = build_tree(scripted(*ROOT_STEPS), scripted(*PAYMENTS_STEPS), gateway=gateway)
    paused = await tree.root.run(CUSTOMER, deps=_deps([], CUSTOMER))
    assert isinstance(paused.output, DeferredToolRequests)
    history = paused.all_messages()
    results = DeferredToolResults(approvals={paused.output.approvals[0].tool_call_id: answer})
    resumed = await tree.root.run(message_history=history, deferred_tool_results=results, deps=_deps(history, CUSTOMER))
    return resumed.all_messages()


def _execute_returns(messages: Sequence[ModelMessage]) -> list[Any]:
    return [
        p.content
        for m in messages
        for p in m.parts
        if isinstance(p, ToolReturnPart) and p.tool_name == "execute_transfer"
    ]


APPROVED = ToolApproved(override_args={"draft_id": DRAFT_ID, "step_up_token": "step-up-from-the-app"})


@pytest.mark.parametrize("answer", [APPROVED, ToolDenied("El cliente canceló.")], ids=["executed", "denied"])
async def test_a_decided_draft_raises_no_interrupt_in_a_laterper_turn(answer: ToolApproved | ToolDenied) -> None:
    gateway = FakeGateway()
    history = await _firstper_turn(gateway, answer)
    executed = len(gateway.called("execute_transfer"))

    later = "¿Qué beneficiarios tengo?"
    tree = build_tree(
        per_turn(
            ("ask_payments", {"request": "listar beneficiarios"}), ("execute_transfer", {"draft_id": DRAFT_ID}), "x"
        ),
        scripted(("list_beneficiaries", {}), "Tenés a Ana."),
        gateway=gateway,
    )
    result = await tree.root.run(later, message_history=history, deps=_deps(history, CUSTOMER, later))

    assert not isinstance(result.output, DeferredToolRequests)
    assert _execute_returns(result.new_messages()) == [DENIAL]
    assert len(gateway.called("execute_transfer")) == executed


async def test_a_superseded_draft_raises_no_interrupt_and_the_newer_one_does() -> None:
    gateway = FakeGateway()
    first = build_tree(per_turn(ROOT_STEPS[0], "Te la preparé."), scripted(*PAYMENTS_STEPS), gateway=gateway)
    history = (await first.root.run(CUSTOMER, deps=_deps([], CUSTOMER))).all_messages()

    gateway.prepare_result = {**DRAFT, "draft_id": NEWER_DRAFT_ID}
    again = "Mejor mandale 60.000"
    steps = (
        ROOT_STEPS[0],
        ("execute_transfer", {"draft_id": DRAFT_ID}),
        ("execute_transfer", {"draft_id": NEWER_DRAFT_ID}),
    )
    second = build_tree(per_turn(*steps), scripted(*PAYMENTS_STEPS), gateway=gateway)
    result = await second.root.run(again, message_history=history, deps=_deps(history, CUSTOMER, again))

    assert _execute_returns(result.new_messages()) == [DENIAL]
    assert isinstance(result.output, DeferredToolRequests)
    [approval] = result.output.approvals
    assert result.output.metadata[approval.tool_call_id]["draft_id"] == NEWER_DRAFT_ID
    assert gateway.called("execute_transfer") == []


@pytest.mark.filterwarnings("ignore::UserWarning")
async def test_a_new_message_after_an_unanswered_interrupt_raises_it_again_for_the_same_draft(
    signing_key: SigningKey, verifier: JwksTokenVerifier, tmp_path: Path
) -> None:
    """The failed-resume recovery: nothing decided the draft, so asking again pauses on it again."""
    tree = build_tree(per_turn(ROOT_STEPS[0], ("execute_transfer", delegated_draft)), scripted(*PAYMENTS_STEPS))
    app = create_app(tree_settings(tmp_path), agent=tree.root, token_verifier=verifier, guardrails=open_guardrails())
    headers = {"accept": "text/event-stream", "authorization": f"Bearer {signing_key.token(sub='juan')}"}
    base = {"threadId": "t", "tools": [], "context": [], "state": {}, "forwardedProps": {}}
    messages: list[dict[str, Any]] = [{"id": "u", "role": "user", "content": CUSTOMER}]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        first = _events(
            (await http.post("/agent", json={**base, "runId": "r1", "messages": messages}, headers=headers)).text
        )
        fold(first, messages)
        messages.append({"id": "u2", "role": "user", "content": "Enviala de nuevo"})
        second = _events(
            (await http.post("/agent", json={**base, "runId": "r2", "messages": messages}, headers=headers)).text
        )

    [again] = second[-1]["outcome"]["interrupts"]
    assert again["metadata"]["draft_id"] == DRAFT_ID
    assert again["toolCallId"] != first[-1]["outcome"]["interrupts"][0]["toolCallId"]


def _events(sse: str) -> list[dict[str, Any]]:
    return [json.loads(line[6:]) for line in sse.splitlines() if line.startswith("data: ")]
