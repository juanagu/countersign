"""After the bank answers an approved `execute_transfer` with an error about its draft, that draft raises no second
interrupt: not later in the resumed run, nor on the next turn (rule 3).

The most realistic path the tests allow: the real `/agent` route and agent tree, a JSON round-tripping conversation
store, and the real `MCPToolset` over HTTP to a fake gateway that answers as mcp-payments does (`isError` with
mcp-kit's `{error, message}` text).
"""

import asyncio
import json
import socket
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx
import pytest
import uvicorn
from fastmcp import FastMCP
from httpx import ASGITransport, AsyncClient
from mcp.types import CallToolResult, TextContent
from pydantic import TypeAdapter
from pydantic_ai.conversation_store import ConversationEntry, ConversationRecord, InMemoryConversationStore
from pydantic_ai.messages import ModelMessage, ModelRequest, UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel

from app.auth.token_verifier import JwksTokenVerifier
from app.banking.mcp_toolsets import banking_toolset
from app.banking.token_exchange import TokenExchanger
from app.core.clock import BankClock
from app.main import build_agent_tree, create_app
from evals.agui_client import fold
from tests.conftest import SigningKey, open_guardrails
from tests.subagents.fakes import DRAFT, DRAFT_ID, PAYMENTS_STEPS, SKILLS, SUBAGENTS, per_turn, scripted, tree_settings

CUSTOMER, AGAIN = "Mandale 50.000 a Ana", "Enviala de nuevo"
STEP_UP = "step-up-from-the-app"
APPROVED = {"approved": True, "editedArgs": {"draft_id": DRAFT_ID, "step_up_token": STEP_UP}}
EXECUTE = ("execute_transfer", {"draft_id": DRAFT_ID})
ASK = ("ask_payments", {"request": "Preparar la transferencia a Ana"})
DENIAL = {"error": "policy_denied", "reason": "the draft is not this conversation's open draft"}
# mcp-payments' answers about a draft it was asked to execute (execute-transfer.ts), as mcp-kit's `fail` sends them.
BANK_ERRORS = {
    "draft_expired": "La transferencia preparada venció. Preparala de nuevo.",
    "draft_not_pending": "Esa transferencia ya no está pendiente.",
}


class SerializingStore(InMemoryConversationStore):
    """Keeps only what survives JSON, as the Postgres store does with the same type adapters."""

    _record, _entry = TypeAdapter(ConversationRecord), TypeAdapter(ConversationEntry)

    async def write_record(
        self,
        record: ConversationRecord,
        *,
        new_entries: Sequence[ConversationEntry] = (),
        expected_revision: str | None,
    ) -> None:
        await super().write_record(
            self._record.validate_json(self._record.dump_json(record)),
            new_entries=[self._entry.validate_json(self._entry.dump_json(entry)) for entry in new_entries],
            expected_revision=expected_revision,
        )


@dataclass
class Gateway:
    url: str
    error: str  # What the bank answers every execute_transfer with.
    executed: list[str] = field(default_factory=list)


def _bank(error: str) -> FastMCP:
    mcp = FastMCP("fake-gateway")

    def meta(tier: str, scope: str, **extra: str) -> dict[str, str]:
        return {"bank/riskTier": tier, "bank/scope": scope, **extra}

    @mcp.tool(meta=meta("T1", "beneficiaries:read"))
    def list_beneficiaries() -> dict[str, Any]:
        return {"beneficiaries": [{"id": "ben-juan-ana", "name": "Ana Gómez"}]}

    @mcp.tool(meta=meta("T2", "transfers:prepare"))
    def prepare_transfer(beneficiary_id: str, source_account_id: str, amount: float, currency: str) -> dict[str, Any]:
        return DRAFT

    @mcp.tool(meta=meta("T3", "transfers:execute", **{"bank/listScope": "transfers:prepare"}))
    def execute_transfer(draft_id: str, step_up_token: str = "") -> CallToolResult:
        mcp.executed.append(draft_id)  # type: ignore[attr-defined]
        body = json.dumps({"error": error, "message": BANK_ERRORS[error]})
        return CallToolResult(isError=True, content=[TextContent(type="text", text=body)])

    mcp.executed = []  # type: ignore[attr-defined]
    return mcp


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture(params=sorted(BANK_ERRORS))
async def gateway(request: pytest.FixtureRequest) -> AsyncIterator[Gateway]:
    bank = _bank(request.param)
    port = _free_port()
    app = bank.http_app(path="/mcp", stateless_http=True, json_response=True)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:  # noqa: ASYNC110 (uvicorn exposes no started event)
        await asyncio.sleep(0.01)
    yield Gateway(f"http://127.0.0.1:{port}/mcp", request.param, bank.executed)  # type: ignore[attr-defined]
    server.should_exit = True
    await task


def _exchanger() -> TokenExchanger:
    def token(request: httpx.Request) -> httpx.Response:
        scope = dict(httpx.QueryParams(request.content.decode()))["scope"]
        return httpx.Response(200, json={"access_token": f"tok:{scope}", "token_type": "Bearer", "scope": scope})

    return TokenExchanger(
        httpx.AsyncClient(transport=httpx.MockTransport(token)),
        token_url="http://idp.test/token",
        client_id="bot",
        client_secret="s3cret",
    )


def _by_prompt(models: dict[str, FunctionModel]) -> FunctionModel:
    """The script of the first key any prompt holds, in the keys' order: a later turn's key goes first."""

    def pick(messages: list[ModelMessage]) -> FunctionModel:
        prompts = " ".join(
            str(p.content)
            for m in messages
            if isinstance(m, ModelRequest)
            for p in m.parts
            if isinstance(p, UserPromptPart)
        )
        return next(model for text, model in models.items() if text in prompts)

    async def stream(messages: list[ModelMessage], info: AgentInfo):  # type: ignore[no-untyped-def]
        async for chunk in pick(messages).stream_function(messages, info):  # type: ignore[misc]
            yield chunk

    return FunctionModel(lambda m, i: pick(m).function(m, i), stream_function=stream)  # type: ignore[misc]


def _root() -> FunctionModel:
    """Ask, pause on execute; after the bank's error, ask again and execute the same draft. Next turn, execute the
    same draft once more."""
    return _by_prompt({AGAIN: per_turn(EXECUTE, "Listo."), "": per_turn(ASK, EXECUTE, ASK, EXECUTE, "Listo.")})


def _payments() -> FunctionModel:
    """Prepares the draft when first asked; asked again, it answers without any tool call."""
    return _by_prompt({"<your_previous_reply>": scripted("Ya te la preparé."), "": scripted(*PAYMENTS_STEPS)})


def _events(sse: str) -> list[dict[str, Any]]:
    return [json.loads(line[6:]) for line in sse.splitlines() if line.startswith("data: ")]


def _interrupts(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [i for e in events if e["type"] == "RUN_FINISHED" for i in (e.get("outcome") or {}).get("interrupts") or []]


def _execute_results(started: list[dict[str, Any]], run: list[dict[str, Any]]) -> list[Any]:
    """The `execute_transfer` results `run` streamed, named by the start events in `started`."""
    names = {e["toolCallId"]: e["toolCallName"] for e in started if e["type"] == "TOOL_CALL_START"}
    return [
        json.loads(e["content"])
        for e in run
        if e["type"] == "TOOL_CALL_RESULT" and names.get(e["toolCallId"]) == "execute_transfer"
    ]


@pytest.mark.filterwarnings("ignore::UserWarning")
async def test_a_draft_the_bank_refused_after_approval_raises_no_second_interrupt(
    gateway: Gateway, signing_key: SigningKey, verifier: JwksTokenVerifier, tmp_path: Path
) -> None:
    root = build_agent_tree(
        _root(),
        lambda _: _payments(),
        skills=SKILLS,
        subagents=SUBAGENTS,
        banking=lambda scopes: banking_toolset(_exchanger(), gateway_url=gateway.url, scopes_by_skill=scopes),
        clock=BankClock(),
    )
    app = create_app(
        tree_settings(tmp_path),
        agent=root,
        token_verifier=verifier,
        guardrails=open_guardrails(),
        conversation_store=SerializingStore(),
    )
    headers = {"accept": "text/event-stream", "authorization": f"Bearer {signing_key.token(sub='juan')}"}
    base = {"threadId": "t", "tools": [], "context": [], "state": {}, "forwardedProps": {}}
    messages: list[dict[str, Any]] = [{"id": "u", "role": "user", "content": CUSTOMER}]

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:

        async def post(run_id: str, **extra: Any) -> list[dict[str, Any]]:
            body = {**base, "runId": run_id, "messages": messages, **extra}
            events = _events((await http.post("/agent", json=body, headers=headers)).text)
            fold(events, messages)
            return events

        first = await post("r1")
        [interrupt] = _interrupts(first)
        assert interrupt["metadata"]["draft_id"] == DRAFT_ID
        # As CopilotKit resumes: its answer to the paused call, and the `resume` entry with the step-up token.
        answer = {"id": "ck", "role": "tool", "toolCallId": interrupt["toolCallId"], "content": json.dumps(APPROVED)}
        messages.append(answer)
        resumed = await post("r2", resume=[{"interruptId": interrupt["id"], "status": "resolved", "payload": APPROVED}])
        messages.append({"id": "u2", "role": "user", "content": AGAIN})
        next_turn = await post("r3")

    assert gateway.executed == [DRAFT_ID]  # The bank was asked once, on the approval.
    started = [*first, *resumed]  # The resumed call's start event came in the run that paused on it.
    assert _execute_results(started, resumed) == [
        {"error": gateway.error, "message": BANK_ERRORS[gateway.error]},
        DENIAL,
    ]
    assert _interrupts(resumed) == []
    assert _execute_results(next_turn, next_turn) == [DENIAL]
    assert _interrupts(next_turn) == []
