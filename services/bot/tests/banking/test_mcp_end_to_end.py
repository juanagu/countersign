"""The agent → policy → MCP path over real HTTP, against a fake MCP gateway that records what it receives."""

import asyncio
import json
import socket
from collections.abc import AsyncIterator, Sequence
from dataclasses import dataclass, field
from typing import Any

import httpx
import pytest
import uvicorn
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
from pydantic_ai import Agent, DeferredToolRequests, DeferredToolResults, ToolApproved
from pydantic_ai.mcp import MCPToolset
from pydantic_ai.messages import (
    ModelMessage,
    ModelResponse,
    RetryPromptPart,
    TextPart,
    ToolCallPart,
    ToolReturnPart,
)
from pydantic_ai.models.function import AgentInfo, FunctionModel
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.banking.mcp_toolsets import banking_toolset
from app.banking.token_exchange import TokenExchanger
from app.chat.agent import build_agent
from app.chat.deps import BotDeps
from app.skills.registry import SkillRegistry
from tests.conftest import TEST_SKILLS_DIR, open_guard

INCOMING_TOKEN = "incoming-aud-bot-token"
DRAFT_ID = "drf_0b3a6f9e-4c1d-4e2a-9f7b-1a2b3c4d5e6f"
STEP_UP = "step-up-from-the-app"
EXECUTE = frozenset({"transfers:execute"})
ACCOUNTS = frozenset({"accounts:read"})
PAYMENTS = frozenset({"accounts:read", "beneficiaries:read", "transfers:prepare"})
SKILLS = SkillRegistry.from_dir(TEST_SKILLS_DIR)


def _deps(*skills: str) -> BotDeps:
    return BotDeps(user_id="ana", access_token=INCOMING_TOKEN, loaded_skills=set(skills), guard=open_guard())


@dataclass(frozen=True)
class Hit:
    """One HTTP request the fake MCP gateway received."""

    server: str
    auth: str
    method: str | None
    tool: str | None


def _rpc(body: bytes) -> tuple[str | None, str | None]:
    try:
        message = json.loads(body)
    except ValueError:
        return None, None
    if not isinstance(message, dict):
        return None, None
    return message.get("method"), (message.get("params") or {}).get("name")


class RecordRequests:
    def __init__(self, app: ASGIApp, name: str, hits: list[Hit]):
        self.app, self.name, self.hits = app, name, hits

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        first = await receive()  # The JSON-RPC body is one chunk for these small requests.
        auth = dict(scope["headers"]).get(b"authorization", b"").decode()
        self.hits.append(Hit(self.name, auth, *_rpc(first.get("body", b""))))
        replayed = False

        async def replay() -> Message:
            nonlocal replayed
            if replayed:
                return await receive()
            replayed = True
            return first

        await self.app(scope, replay, send)


@dataclass
class FakeGateway:
    url: str
    hits: list[Hit]
    executed: list[dict[str, str]]

    def calls(self, tool: str) -> list[Hit]:
        return [hit for hit in self.hits if hit.method == "tools/call" and hit.tool == tool]


def _meta(tier: str, scope: str | None, **extra: str) -> dict[str, Any]:
    return {"bank/riskTier": tier, **({"bank/scope": scope} if scope else {}), **extra}


def _fake_gateway(executed: list[dict[str, str]]) -> FastMCP:
    """The gateway's merged catalog: the accounts tools and the payments tools under one endpoint.

    Like today's gateway it lists and forwards every tool whatever the token's scope: the tests pin what the bot
    asks for and sends, not what the gateway enforces.
    """
    mcp = FastMCP("fake-gateway")

    @mcp.tool(meta=_meta("T1", "accounts:read"))
    def list_accounts() -> dict[str, Any]:
        return {"accounts": [{"id": "acc-ana-ars", "currency": "ARS"}]}

    @mcp.tool(meta=_meta("T1", "accounts:read"))
    def get_balance(account_id: str) -> dict[str, Any]:
        raise ToolError(json.dumps({"error": "account_not_found", "account_id": account_id}))

    @mcp.tool(meta=_meta("T1", None))  # Allow-listed by accounts, but declares no scope.
    def list_transactions() -> dict[str, Any]:
        return {"transactions": []}

    @mcp.tool(meta=_meta("T1", "accounts:read"))
    def secret_admin_tool() -> str:
        return "should never be callable"

    @mcp.tool(meta=_meta("T1", "beneficiaries:read"))
    def list_beneficiaries() -> dict[str, Any]:
        return {"beneficiaries": []}

    @mcp.tool(meta=_meta("T2", "transfers:prepare"))
    def prepare_transfer(beneficiary_id: str, amount: float, currency: str) -> dict[str, Any]:
        return {"draft_id": DRAFT_ID, "beneficiary_id": beneficiary_id, "amount": amount, "currency": currency}

    @mcp.tool(meta=_meta("T3", "transfers:execute", **{"bank/listScope": "transfers:prepare"}))
    def execute_transfer(draft_id: str, step_up_token: str = "") -> dict[str, Any]:
        executed.append({"draft_id": draft_id, "step_up_token": step_up_token})
        return {"transfer_id": "trf_1", "draft_id": draft_id, "reference": "BD-1"}

    return mcp


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture
async def gateway() -> AsyncIterator[FakeGateway]:
    hits: list[Hit] = []
    executed: list[dict[str, str]] = []
    fake = _fake_gateway(executed)
    port = _free_port()
    app = RecordRequests(fake.http_app(path="/mcp", stateless_http=True, json_response=True), fake.name, hits)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:  # noqa: ASYNC110 (uvicorn exposes no started event)
        await asyncio.sleep(0.01)
    yield FakeGateway(f"http://127.0.0.1:{port}/mcp", hits, executed)
    server.should_exit = True
    await task


@dataclass
class FakeIdp:
    """A token endpoint that issues exactly the requested scope and records each exchange."""

    status: int = 200
    refuse: frozenset[str] | None = None  # A scope set it answers 503 for.
    exchanges: list[tuple[str, frozenset[str]]] = field(default_factory=list)
    scopes_by_token: dict[str, frozenset[str]] = field(default_factory=dict)

    def exchanger(self) -> TokenExchanger:
        return TokenExchanger(
            httpx.AsyncClient(transport=httpx.MockTransport(self._token_endpoint)),
            token_url="http://idp.test/token",
            client_id="bot",
            client_secret="s3cret",
        )

    def scopes_of(self, hit: Hit) -> frozenset[str]:
        return self.scopes_by_token[hit.auth.removeprefix("Bearer ")]

    def _token_endpoint(self, request: httpx.Request) -> httpx.Response:
        form = dict(httpx.QueryParams(request.content.decode()))
        scopes = frozenset(form["scope"].split(" "))
        self.exchanges.append((form["audience"], scopes))
        if self.status != httpx.codes.OK or scopes == self.refuse:
            return httpx.Response(self.status if self.status != httpx.codes.OK else 503, json={"error": "x"})
        token = f"tok-{len(self.exchanges)}"
        self.scopes_by_token[token] = scopes
        return httpx.Response(200, json={"access_token": token, "token_type": "Bearer", "scope": form["scope"]})


def _tools(idp: FakeIdp, url: str) -> Any:
    return banking_toolset(idp.exchanger(), gateway_url=url, scopes_by_skill=SKILLS.scopes_by_skill())


def _returns(messages: list[ModelMessage]) -> list[ToolReturnPart | RetryPromptPart]:
    return [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart | RetryPromptPart)]


def _scripted(steps: Sequence[ToolCallPart], seen_tools: list[list[str]] | None = None) -> FunctionModel:
    """Calls each step in turn, one per tool result so far, then answers with the last result."""

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        if seen_tools is not None:
            seen_tools.append(sorted(t.name for t in info.function_tools))
        returns = _returns(messages)
        if len(returns) < len(steps):
            return ModelResponse(parts=[steps[len(returns)]])
        return ModelResponse(parts=[TextPart(json.dumps(returns[-1].content, default=str))])

    return FunctionModel(respond)


def _recording_sessions(monkeypatch: pytest.MonkeyPatch) -> list[MCPToolset[BotDeps]]:
    opened: list[MCPToolset[BotDeps]] = []
    enter = MCPToolset.__aenter__

    async def recording_enter(self: MCPToolset[BotDeps]) -> MCPToolset[BotDeps]:
        opened.append(self)
        return await enter(self)

    monkeypatch.setattr(MCPToolset, "__aenter__", recording_enter)
    return opened


def _distinct(sessions: list[MCPToolset[BotDeps]]) -> list[MCPToolset[BotDeps]]:
    return list({id(session): session for session in sessions}.values())  # Each re-enters itself per request.


LOAD_ACCOUNTS = ToolCallPart("load_skill", {"name": "accounts"})
LOAD_PAYMENTS = ToolCallPart("load_skill", {"name": "payments"})
PREPARE = ToolCallPart("prepare_transfer", {"beneficiary_id": "ben-ana", "amount": 50000, "currency": "ARS"})
EXECUTE_CALL = ToolCallPart("execute_transfer", {"draft_id": DRAFT_ID})


async def test_calls_mcp_with_the_exchanged_token_never_the_incoming_one(gateway: FakeGateway) -> None:
    seen_tools: list[list[str]] = []
    agent = build_agent(
        _scripted([LOAD_ACCOUNTS, ToolCallPart("list_accounts", {})], seen_tools),
        skills=SKILLS,
        domain_tools=[_tools(FakeIdp(), gateway.url)],
    )

    result = await agent.run("¿Qué cuentas tengo?", deps=_deps())

    assert gateway.hits, "the fake MCP gateway received no request"
    assert {hit.auth for hit in gateway.hits} == {"Bearer tok-1"}
    assert not any(INCOMING_TOKEN in hit.auth for hit in gateway.hits)
    # Before load_skill no domain tool is visible; afterwards only the skill's allow-listed ones are.
    assert seen_tools[0] == ["load_skill", "render_ui"]
    assert "list_accounts" in seen_tools[1]
    assert "secret_admin_tool" not in seen_tools[1]
    assert "untrusted_data" in result.output


async def test_domain_errors_reach_the_model_without_spending_the_retry_budget(gateway: FakeGateway) -> None:
    steps = [
        LOAD_ACCOUNTS,
        ToolCallPart("get_balance", {"account_id": "acc-x"}),
        ToolCallPart("get_balance", {"account_id": "acc-y"}),
    ]
    failures: list[str] = []

    def respond(messages: list[ModelMessage], _: AgentInfo) -> ModelResponse:
        failures.extend(str(p.content) for p in messages[-1].parts if isinstance(p, RetryPromptPart | ToolReturnPart))
        step = len(messages) // 2
        return ModelResponse(parts=[steps[step] if step < len(steps) else TextPart("No encontré esas cuentas.")])

    agent = build_agent(FunctionModel(respond), skills=SKILLS, domain_tools=[_tools(FakeIdp(), gateway.url)])

    result = await agent.run("¿Saldo de acc-x y acc-y?", deps=_deps())

    assert result.output == "No encontré esas cuentas."
    assert sum("account_not_found" in failure for failure in failures) == 2


async def test_a_run_that_loads_no_skill_contacts_neither_the_idp_nor_any_mcp_server(gateway: FakeGateway) -> None:
    idp = FakeIdp()
    agent = build_agent(
        FunctionModel(lambda _m, _i: ModelResponse(parts=[TextPart("¡Hola!")])),
        skills=SKILLS,
        domain_tools=[_tools(idp, gateway.url)],
    )

    result = await agent.run("hola", deps=_deps())

    assert result.output == "¡Hola!"
    assert idp.exchanges == []
    assert gateway.hits == []


async def test_a_skill_without_scopes_contacts_neither_the_idp_nor_the_gateway(gateway: FakeGateway) -> None:
    idp = FakeIdp()
    agent = build_agent(
        _scripted([ToolCallPart("load_skill", {"name": "knowledge"})]),
        skills=SKILLS,
        domain_tools=[_tools(idp, gateway.url)],
    )

    await agent.run("¿Cuánto cuesta una transferencia?", deps=_deps())

    assert idp.exchanges == []
    assert gateway.hits == []


async def test_loading_accounts_exchanges_once_for_accounts_read_and_closes_its_session(
    gateway: FakeGateway, monkeypatch: pytest.MonkeyPatch
) -> None:
    idp = FakeIdp()
    opened = _recording_sessions(monkeypatch)
    agent = build_agent(
        _scripted([LOAD_ACCOUNTS, ToolCallPart("list_accounts", {})]),
        skills=SKILLS,
        domain_tools=[_tools(idp, gateway.url)],
    )

    await agent.run("¿Qué cuentas tengo?", deps=_deps())

    # Exactly the skill's scopes, and never a backend audience: the gateway exchanges for those.
    assert idp.exchanges == [("mcp-gateway", ACCOUNTS)]
    assert gateway.calls("list_accounts")
    sessions = _distinct(opened)
    assert [session.id for session in sessions] == ["mcp-gateway"]
    assert not any(session.is_running for session in sessions)


async def test_loading_payments_re_exchanges_for_the_union_and_replaces_the_session(
    gateway: FakeGateway, monkeypatch: pytest.MonkeyPatch
) -> None:
    idp = FakeIdp()
    opened = _recording_sessions(monkeypatch)
    steps = [LOAD_ACCOUNTS, ToolCallPart("list_accounts", {}), LOAD_PAYMENTS, ToolCallPart("list_beneficiaries", {})]
    agent = build_agent(_scripted(steps), skills=SKILLS, domain_tools=[_tools(idp, gateway.url)])

    await agent.run("¿Qué cuentas tengo y a quién le puedo transferir?", deps=_deps())

    assert idp.exchanges == [("mcp-gateway", ACCOUNTS), ("mcp-gateway", PAYMENTS)]
    [accounts_call] = gateway.calls("list_accounts")
    [beneficiaries_call] = gateway.calls("list_beneficiaries")
    assert idp.scopes_of(accounts_call) == ACCOUNTS
    assert idp.scopes_of(beneficiaries_call) == PAYMENTS
    sessions = _distinct(opened)
    assert len(sessions) == 2
    assert not any(session.is_running for session in sessions)


async def test_a_tool_without_a_valid_scope_is_hidden_and_logged_once(
    gateway: FakeGateway, caplog: pytest.LogCaptureFixture
) -> None:
    seen_tools: list[list[str]] = []
    tools = _tools(FakeIdp(), gateway.url)
    agent = build_agent(
        _scripted([LOAD_ACCOUNTS, ToolCallPart("list_accounts", {})], seen_tools), skills=SKILLS, domain_tools=[tools]
    )

    await agent.run("¿Qué cuentas tengo?", deps=_deps())
    await agent.run("¿Qué cuentas tengo?", deps=_deps())

    after_load = [tools for tools in seen_tools if "list_accounts" in tools]
    assert after_load
    assert not any("list_transactions" in tools for tools in after_load)  # Allow-listed by accounts, unscoped.
    hidden = [r for r in caplog.records if r.getMessage() == "mcp tool hidden: no valid scope"]
    assert [r.__dict__["tool"] for r in hidden] == ["list_transactions"]


async def _pause_on_execute(agent: Any) -> Any:
    paused = await agent.run("Mandale 50.000 a Ana", deps=_deps())
    assert isinstance(paused.output, DeferredToolRequests)
    return paused


async def _resume_approved(agent: Any, paused: Any) -> Any:
    call_id = paused.output.approvals[0].tool_call_id
    approved = ToolApproved(override_args={"draft_id": DRAFT_ID, "step_up_token": STEP_UP})
    return await agent.run(
        message_history=paused.all_messages(),
        deferred_tool_results=DeferredToolResults(approvals={call_id: approved}),
        deps=_deps("payments"),  # The route restores skills from the history's load_skill calls.
    )


async def test_an_approved_transfer_executes_on_its_own_execute_only_token(
    gateway: FakeGateway, monkeypatch: pytest.MonkeyPatch
) -> None:
    idp = FakeIdp()
    opened = _recording_sessions(monkeypatch)
    agent = build_agent(
        _scripted([LOAD_PAYMENTS, PREPARE, EXECUTE_CALL]), skills=SKILLS, domain_tools=[_tools(idp, gateway.url)]
    )

    paused = await _pause_on_execute(agent)
    assert gateway.calls("execute_transfer") == []
    resumed = await _resume_approved(agent, paused)

    assert gateway.executed == [{"draft_id": DRAFT_ID, "step_up_token": STEP_UP}]
    assert "BD-1" in str(resumed.output)
    # Two runs, one session each on the skill's scopes, and one exchange for the approved call alone.
    assert idp.exchanges == [("mcp-gateway", PAYMENTS), ("mcp-gateway", PAYMENTS), ("mcp-gateway", EXECUTE)]
    [execute_call] = gateway.calls("execute_transfer")
    assert idp.scopes_of(execute_call) == EXECUTE
    execute_token_hits = [hit for hit in gateway.hits if hit.auth == execute_call.auth]
    # One call. The MCP SDK also lists once to learn the output schema, which the real gateway answers empty.
    assert [hit for hit in execute_token_hits if hit.method == "tools/call"] == [execute_call]
    # No session token ever held transfers:execute: only the one-call token did.
    session_hits = [hit for hit in gateway.hits if hit.auth != execute_call.auth]
    assert session_hits
    assert all("transfers:execute" not in idp.scopes_of(hit) for hit in session_hits)
    assert not any(session.is_running for session in _distinct(opened))


async def test_a_failed_approved_exchange_makes_no_gateway_call(gateway: FakeGateway) -> None:
    idp = FakeIdp(refuse=EXECUTE)
    agent = build_agent(
        _scripted([LOAD_PAYMENTS, PREPARE, EXECUTE_CALL]), skills=SKILLS, domain_tools=[_tools(idp, gateway.url)]
    )

    paused = await _pause_on_execute(agent)
    resumed = await _resume_approved(agent, paused)

    assert idp.exchanges[-1] == ("mcp-gateway", EXECUTE)
    assert gateway.calls("execute_transfer") == []  # Not on the session token either: the step-up stays unspent.
    assert gateway.executed == []
    assert not any(STEP_UP in hit.auth for hit in gateway.hits)
    [failure] = [p for p in _returns(resumed.all_messages()) if p.tool_name == "execute_transfer"]
    assert json.loads(str(failure.content)) == {"error": "service_unavailable", "service": "mcp-gateway"}


async def test_an_unapproved_t3_call_that_bypasses_the_policy_goes_out_on_the_session_token(
    gateway: FakeGateway,
) -> None:
    idp = FakeIdp()
    # No PolicyToolset in front: as if the policy had a bug and let the call through without approval.
    agent: Agent[BotDeps, str] = Agent(
        _scripted([ToolCallPart("execute_transfer", {"draft_id": DRAFT_ID, "step_up_token": STEP_UP})]),
        deps_type=BotDeps,
        toolsets=[_tools(idp, gateway.url)],
    )

    await agent.run("Mandale 50.000 a Ana", deps=_deps("payments"))

    assert idp.exchanges == [("mcp-gateway", PAYMENTS)]  # Never transfers:execute.
    [execute_call] = gateway.calls("execute_transfer")
    assert idp.scopes_of(execute_call) == PAYMENTS  # The real gateway refuses it: insufficient_scope.


@pytest.mark.parametrize("failure", ["idp_down", "mcp_unreachable"])
async def test_a_server_that_fails_to_connect_degrades_the_run_instead_of_failing_it(
    gateway: FakeGateway, caplog: pytest.LogCaptureFixture, failure: str
) -> None:
    gateway_url = f"http://127.0.0.1:{_free_port()}/mcp" if failure == "mcp_unreachable" else gateway.url
    idp = FakeIdp(status=500 if failure == "idp_down" else 200)
    seen_tools: list[list[str]] = []
    instructions: list[str] = []

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen_tools.append(sorted(t.name for t in info.function_tools))
        instructions.append(info.instructions or "")
        if len(seen_tools) == 1:
            return ModelResponse(parts=[LOAD_ACCOUNTS])
        return ModelResponse(parts=[TextPart("El servicio no está disponible.")])

    agent = build_agent(FunctionModel(respond), skills=SKILLS, domain_tools=[_tools(idp, gateway_url)])

    result = await agent.run("¿Qué cuentas tengo?", deps=BotDeps(user_id="ana", access_token=INCOMING_TOKEN))

    assert result.output == "El servicio no está disponible."
    assert "list_accounts" not in seen_tools[1]
    assert "unavailable right now: mcp-gateway" in instructions[1]
    assert "unavailable" not in instructions[0]
    assert gateway.hits == []  # The fake gateway is never reached, whichever hop failed.
    logged = [r for r in caplog.records if r.getMessage() == "mcp server unavailable"]
    assert [r.__dict__["server"] for r in logged] == ["mcp-gateway"]  # Once per run, not once per step.
    assert not any(INCOMING_TOKEN in str(r.__dict__) for r in caplog.records)
