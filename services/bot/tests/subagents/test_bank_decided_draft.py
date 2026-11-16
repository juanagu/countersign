"""After the bank answers an approved `execute_transfer` with an error that decides its draft, that draft raises no
second interrupt: not later in the resumed run, nor on the next turn (rule 3). The answers in
`UNDECIDING_BANK_ERRORS` decide nothing (ADR 023: nothing moved with the spent token, nothing was spent, or the
outcome is unknown), so the draft stays open and the next approval is a fresh interrupt that needs a new step-up
token, never the spent one. After the ones that may leave an execution running the same run raises no second
interrupt; the customer's next message does.

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
from app.policy.policy_toolset import DRAFT_HELD
from evals.agui_client import fold
from tests.conftest import SigningKey, open_guardrails
from tests.subagents.fakes import (
    DRAFT,
    DRAFT_ID,
    PAYMENTS_STEPS,
    RECEIPT,
    SKILLS,
    SUBAGENTS,
    per_turn,
    scripted,
    tree_settings,
)

CUSTOMER, AGAIN = "Mandale 50.000 a Ana", "Enviala de nuevo"
STEP_UP, FRESH_STEP_UP = "step-up-from-the-app", "fresh-step-up-from-the-app"
SERVER_START_TIMEOUT = 10.0
EXECUTE = ("execute_transfer", {"draft_id": DRAFT_ID})
ASK = ("ask_payments", {"request": "Preparar la transferencia a Ana"})
DENIAL = {"error": "policy_denied", "reason": "the draft is not this conversation's open draft"}
# mcp-payments' answers about a draft it was asked to execute (execute-transfer.ts), as mcp-kit's `fail` sends them.
BANK_ERRORS = {
    "draft_expired": "La transferencia preparada venció. Preparala de nuevo.",
    "draft_not_pending": "Esa transferencia ya no está pendiente.",
    "insufficient_funds": "El saldo disponible ya no alcanza para esta transferencia.",
    "token_already_used": "Esa confirmación ya se usó. Confirmá de nuevo con tu PIN.",
    "execution_in_progress": (
        "La transferencia se está procesando. Esperá unos segundos y confirmá de nuevo con tu PIN."
    ),
    "account_busy": "La cuenta de origen está ocupada con otra operación. Esperá unos segundos y confirmá de nuevo.",
    "internal_error": "No pude confirmar si la transferencia se realizó. Confirmá de nuevo con tu PIN.",
    # The gateway's own answer when mcp-payments timed out (the message is the fake bank's, the code the gateway's).
    "upstream_error": "El servicio de transferencias no respondió a tiempo.",
}
# The first execution ended without moving anything: asking again at once is right.
LEAVES_OPEN = ("token_already_used",)
# The first execution may still be running or may have committed: open, but not again in the same run.
HELD_OPEN = ("execution_in_progress", "account_busy", "internal_error", "upstream_error")
DECIDES = sorted(set(BANK_ERRORS) - set(LEAVES_OPEN) - set(HELD_OPEN))
HELD = {"error": "policy_denied", "reason": DRAFT_HELD}


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
    error: str  # What the bank answers the first execute_transfer with; a later one gets the receipt.
    executed: list[tuple[str, str]] = field(default_factory=list)  # (draft_id, step_up_token) of each call.


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
        mcp.executed.append((draft_id, step_up_token))  # type: ignore[attr-defined]
        if len(mcp.executed) > 1:  # type: ignore[attr-defined]
            return CallToolResult(
                content=[TextContent(type="text", text=json.dumps(RECEIPT))], structuredContent=RECEIPT
            )
        body = json.dumps({"error": error, "message": BANK_ERRORS[error]})
        return CallToolResult(isError=True, content=[TextContent(type="text", text=body)])

    mcp.executed = []  # type: ignore[attr-defined]
    return mcp


async def _started(server: uvicorn.Server, task: "asyncio.Task[None]") -> None:
    while not server.started:
        if task.done():  # A failed start ends the task (uvicorn exits the process on a bind error).
            raise RuntimeError(f"the fake gateway stopped before it started: {task.exception()!r}")
        await asyncio.sleep(0.01)


@pytest.fixture
async def gateway(request: pytest.FixtureRequest) -> AsyncIterator[Gateway]:
    """The fake bank answering every execute_transfer with the error code the test parametrizes (indirect)."""
    bank = _bank(request.param)
    app = bank.http_app(path="/mcp", stateless_http=True, json_response=True)
    # The listening socket is handed to uvicorn, so no other process can take the port between choosing and binding.
    sock = socket.create_server(("127.0.0.1", 0))
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))
    task = asyncio.create_task(server.serve(sockets=[sock]))
    try:
        await asyncio.wait_for(_started(server, task), SERVER_START_TIMEOUT)
        url = f"http://127.0.0.1:{sock.getsockname()[1]}/mcp"
        yield Gateway(url, request.param, bank.executed)  # type: ignore[attr-defined]
    finally:
        server.should_exit = True
        await asyncio.wait({task}, timeout=SERVER_START_TIMEOUT)
        task.cancel()
        sock.close()


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


@dataclass
class Chat:
    """One customer's conversation over the real route: each post folds the streamed events into its messages."""

    http: AsyncClient
    headers: dict[str, str]
    messages: list[dict[str, Any]] = field(default_factory=lambda: [{"id": "u", "role": "user", "content": CUSTOMER}])

    async def post(self, run_id: str, **extra: Any) -> list[dict[str, Any]]:
        base = {"threadId": "t", "tools": [], "context": [], "state": {}, "forwardedProps": {}}
        body = {**base, "runId": run_id, "messages": self.messages, **extra}
        events = _events((await self.http.post("/agent", json=body, headers=self.headers)).text)
        fold(events, self.messages)
        return events

    async def approve(self, run_id: str, interrupt: dict[str, Any], step_up_token: str) -> list[dict[str, Any]]:
        """As CopilotKit resumes: its answer to the paused call, and the `resume` entry with the step-up token."""
        approved = {"approved": True, "editedArgs": {"draft_id": DRAFT_ID, "step_up_token": step_up_token}}
        answer = {"id": f"ck-{run_id}", "role": "tool", "toolCallId": interrupt["toolCallId"]}
        self.messages.append({**answer, "content": json.dumps(approved)})
        resume = [{"interruptId": interrupt["id"], "status": "resolved", "payload": approved}]
        return await self.post(run_id, resume=resume)


@pytest.fixture
async def chat(
    gateway: Gateway, signing_key: SigningKey, verifier: JwksTokenVerifier, tmp_path: Path
) -> AsyncIterator[Chat]:
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
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as http:
        yield Chat(http, headers)


@pytest.mark.filterwarnings("ignore::UserWarning")
@pytest.mark.parametrize("gateway", DECIDES, indirect=True)
async def test_a_draft_the_bank_refused_after_approval_raises_no_second_interrupt(gateway: Gateway, chat: Chat) -> None:
    first = await chat.post("r1")
    [interrupt] = _interrupts(first)
    assert interrupt["metadata"]["draft_id"] == DRAFT_ID
    resumed = await chat.approve("r2", interrupt, STEP_UP)
    chat.messages.append({"id": "u2", "role": "user", "content": AGAIN})
    next_turn = await chat.post("r3")

    assert gateway.executed == [(DRAFT_ID, STEP_UP)]  # The bank was asked once, on the approval.
    started = [*first, *resumed]  # The resumed call's start event came in the run that paused on it.
    assert _execute_results(started, resumed) == [
        {"error": gateway.error, "message": BANK_ERRORS[gateway.error]},
        DENIAL,
    ]
    assert _interrupts(resumed) == []
    assert _execute_results(next_turn, next_turn) == [DENIAL]
    assert _interrupts(next_turn) == []


@pytest.mark.filterwarnings("ignore::UserWarning")
@pytest.mark.parametrize("gateway", LEAVES_OPEN, indirect=True)
async def test_a_draft_the_bank_left_pending_pauses_again_and_needs_a_fresh_step_up_token(
    gateway: Gateway, chat: Chat
) -> None:
    first = await chat.post("r1")
    [interrupt] = _interrupts(first)
    resumed = await chat.approve("r2", interrupt, STEP_UP)
    [again] = _interrupts(resumed)  # The draft is still pending: executing it again pauses for approval.
    assert again["metadata"]["draft_id"] == DRAFT_ID
    assert again["id"] != interrupt["id"]
    assert gateway.executed == [(DRAFT_ID, STEP_UP)]  # Pausing sent nothing to the bank.

    confirmed = await chat.approve("r3", again, FRESH_STEP_UP)

    assert gateway.executed == [(DRAFT_ID, STEP_UP), (DRAFT_ID, FRESH_STEP_UP)]  # The spent token is never sent twice.
    started = [*first, *resumed, *confirmed]
    assert _execute_results(started, resumed) == [{"error": gateway.error, "message": BANK_ERRORS[gateway.error]}]
    [receipt] = _execute_results(started, confirmed)
    assert receipt["untrusted_data"] == RECEIPT  # The bank's receipt, wrapped as data like any tool result.
    assert _interrupts(confirmed) == []


@pytest.mark.filterwarnings("ignore::UserWarning")
@pytest.mark.parametrize("gateway", HELD_OPEN, indirect=True)
async def test_a_draft_whose_execution_may_still_run_raises_no_second_interrupt_until_the_next_message(
    gateway: Gateway, chat: Chat
) -> None:
    first = await chat.post("r1")
    [interrupt] = _interrupts(first)
    resumed = await chat.approve("r2", interrupt, STEP_UP)

    # The model asks again in the same run: no second PIN card, nothing sent to the bank.
    assert _interrupts(resumed) == []
    assert gateway.executed == [(DRAFT_ID, STEP_UP)]
    started = [*first, *resumed]
    assert _execute_results(started, resumed) == [{"error": gateway.error, "message": BANK_ERRORS[gateway.error]}, HELD]

    # The customer confirms on their next message: the draft is open, and the approval needs a fresh token.
    chat.messages.append({"id": "u2", "role": "user", "content": AGAIN})
    next_turn = await chat.post("r3")
    [again] = _interrupts(next_turn)
    assert again["metadata"]["draft_id"] == DRAFT_ID
    confirmed = await chat.approve("r4", again, FRESH_STEP_UP)

    assert gateway.executed == [(DRAFT_ID, STEP_UP), (DRAFT_ID, FRESH_STEP_UP)]
    [receipt] = _execute_results([*started, *next_turn, *confirmed], confirmed)
    assert receipt["untrusted_data"] == RECEIPT
    assert _interrupts(confirmed) == []
