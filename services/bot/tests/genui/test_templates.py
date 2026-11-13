"""The confirm card's figures come from the tool result through code, whatever the model writes."""

import json
from collections.abc import AsyncIterator
from typing import Any

from httpx import ASGITransport, AsyncClient
from pydantic_ai.messages import ModelMessage, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, DeltaToolCall, DeltaToolCalls, FunctionModel
from pydantic_ai.toolsets import FunctionToolset

from app.auth.token_verifier import JwksTokenVerifier
from app.chat.agent import build_agent
from app.chat.deps import BotDeps
from app.config import SKILLS_DIR
from app.guardrails.output_guard import UNGROUNDED_FALLBACK
from app.main import create_app
from app.skills.registry import SkillRegistry
from tests.conftest import SigningKey, make_settings, open_guardrails

DRAFT: dict[str, Any] = {
    "draft_id": "drf_123",
    "status": "pending",
    "amount": "50000.00",
    "fee": "0.00",
    "total": "50000.00",
    "currency": "ARS",
    "source_account": {"id": "acc-juan-ars", "alias": "Cuenta corriente en pesos", "number": "****7810"},
    "beneficiary": {
        "id": "ben-juan-ana",
        "name": "Ana Gómez",
        "bank": "Banco Demo",
        "account": "****5211",
        "currency": "ARS",
    },
    "expires_at": "2026-11-13T12:05:00.000Z",
}


def _fake_payments() -> FunctionToolset[BotDeps]:
    toolset: FunctionToolset[BotDeps] = FunctionToolset()

    @toolset.tool_plain(metadata={"meta": {"bank/riskTier": "T2"}})
    def prepare_transfer(source_account_id: str, beneficiary_id: str, amount: float, currency: str) -> dict[str, Any]:
        return DRAFT

    return toolset


async def _lying_model(messages: list[ModelMessage], _: AgentInfo) -> AsyncIterator[str | DeltaToolCalls]:
    returns = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
    if not returns:
        yield {0: DeltaToolCall(name="load_skill", json_args=json.dumps({"name": "payments"}))}
    elif len(returns) == 1:
        args = {
            "source_account_id": "acc-juan-ars",
            "beneficiary_id": "ben-juan-ana",
            "amount": 50000,
            "currency": "ARS",
        }
        yield {0: DeltaToolCall(name="prepare_transfer", json_args=json.dumps(args))}
    else:
        yield "Listo, preparé una transferencia de $ 999.999 a Mallory."


async def test_confirm_card_comes_from_the_draft_not_the_model_text(
    signing_key: SigningKey, verifier: JwksTokenVerifier
) -> None:
    agent = build_agent(
        FunctionModel(stream_function=_lying_model),
        skills=SkillRegistry.from_dir(SKILLS_DIR),
        domain_tools=[_fake_payments()],
    )
    app = create_app(make_settings(), agent=agent, token_verifier=verifier, guardrails=open_guardrails())
    body = {
        "threadId": "t",
        "runId": "r",
        "messages": [{"id": "u", "role": "user", "content": "Mandale 50.000 a Ana"}],
        "tools": [],
        "context": [],
        "state": {},
        "forwardedProps": {},
    }
    headers = {"accept": "text/event-stream", "authorization": f"Bearer {signing_key.token(sub='juan')}"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        res = await http.post("/agent", json=body, headers=headers)

    events = [json.loads(line[6:]) for line in res.text.splitlines() if line.startswith("data: ")]
    cards = [e for e in events if e["type"] == "ACTIVITY_SNAPSHOT" and e["activityType"] == "bank-template"]
    assert len(cards) == 1
    card = cards[0]["content"]
    assert card["template"] == "transfer-confirm"
    assert card["data"]["amount"] == "50000.00"
    assert card["data"]["beneficiary"]["name"] == "Ana Gómez"
    assert card["data"]["draftId"] == "drf_123"
    text = "".join(e["delta"] for e in events if e["type"] == "TEXT_MESSAGE_CONTENT")
    # The card keeps the draft's figures; the model's invented amount never reaches the client (output guard).
    assert "999.999" not in text
    assert UNGROUNDED_FALLBACK in text
    assert "999" not in json.dumps(card)
