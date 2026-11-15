"""The agent → policy → MCP path over real HTTP, against a fake MCP gateway that records what it receives."""

import asyncio
import json
import socket
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import uvicorn
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError
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
from starlette.types import ASGIApp, Receive, Scope, Send

from app.banking.mcp_toolsets import GATEWAY_NEEDED_BY, banking_toolset
from app.banking.token_exchange import TokenExchanger
from app.chat.agent import build_agent
from app.chat.deps import BotDeps
from app.config import SKILLS_DIR
from app.skills.registry import SkillRegistry
from tests.conftest import open_guard


def _deps() -> BotDeps:
    return BotDeps(user_id="ana", access_token=INCOMING_TOKEN, guard=open_guard())


INCOMING_TOKEN = "incoming-aud-bot-token"


Seen = list[tuple[str, str]]
"""(server name, Authorization header) per HTTP request the fake MCP gateway received."""


class RecordAuth:
    def __init__(self, app: ASGIApp, name: str, seen: Seen):
        self.app, self.name, self.seen = app, name, seen

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            self.seen.append((self.name, dict(scope["headers"]).get(b"authorization", b"").decode()))
        await self.app(scope, receive, send)


def _fake_gateway() -> FastMCP:
    """The gateway's merged catalog: the accounts tools and the payments tools under one endpoint."""
    mcp = FastMCP("fake-gateway")

    @mcp.tool(meta={"bank/riskTier": "T1"})
    def list_accounts() -> dict[str, Any]:
        return {"accounts": [{"id": "acc-ana-ars", "currency": "ARS"}]}

    @mcp.tool(meta={"bank/riskTier": "T1"})
    def get_balance(account_id: str) -> dict[str, Any]:
        raise ToolError(json.dumps({"error": "account_not_found", "account_id": account_id}))

    @mcp.tool(meta={"bank/riskTier": "T1"})
    def secret_admin_tool() -> str:
        return "should never be callable"

    @mcp.tool(meta={"bank/riskTier": "T1"})
    def list_beneficiaries() -> dict[str, Any]:
        return {"beneficiaries": []}

    return mcp


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture
async def fake_gateway() -> AsyncIterator[tuple[str, Seen]]:
    seen: Seen = []
    fake = _fake_gateway()
    port = _free_port()
    app = RecordAuth(fake.http_app(path="/mcp", stateless_http=True, json_response=True), fake.name, seen)
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    while not server.started:  # noqa: ASYNC110 (uvicorn exposes no started event)
        await asyncio.sleep(0.01)
    yield f"http://127.0.0.1:{port}/mcp", seen
    server.should_exit = True
    await task


def _exchanger(audiences: list[str] | None = None, *, status: int = 200) -> TokenExchanger:
    """A token exchanger against a fake IdP that records each audience it is asked for."""

    def token_endpoint(request: httpx.Request) -> httpx.Response:
        if status != httpx.codes.OK:
            return httpx.Response(status, json={"error": "server_error"})
        audience = dict(httpx.QueryParams(request.content.decode()))["audience"]
        if audiences is not None:
            audiences.append(audience)
        return httpx.Response(
            200, json={"access_token": f"exchanged-{audience}", "expires_in": 300, "token_type": "Bearer"}
        )

    return TokenExchanger(
        httpx.AsyncClient(transport=httpx.MockTransport(token_endpoint)),
        token_url="http://idp.test/token",
        client_id="bot",
        client_secret="s3cret",
    )


def _scripted_model(seen_tools: list[list[str]]) -> FunctionModel:
    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen_tools.append(sorted(t.name for t in info.function_tools))
        returns = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
        if not returns:
            return ModelResponse(parts=[ToolCallPart("load_skill", {"name": "accounts"})])
        if len(returns) == 1:
            return ModelResponse(parts=[ToolCallPart("list_accounts", {})])
        return ModelResponse(parts=[TextPart(json.dumps(returns[-1].content, default=str))])

    return FunctionModel(respond)


async def test_calls_mcp_with_the_exchanged_token_never_the_incoming_one(
    fake_gateway: tuple[str, Seen],
) -> None:
    gateway_url, seen = fake_gateway

    exchanger = _exchanger()
    seen_tools: list[list[str]] = []
    tools = banking_toolset(exchanger, gateway_url=gateway_url)
    agent = build_agent(_scripted_model(seen_tools), skills=SkillRegistry.from_dir(SKILLS_DIR), domain_tools=[tools])

    result = await agent.run("¿Qué cuentas tengo?", deps=_deps())

    seen_auth = [header for _, header in seen]
    assert seen_auth, "the fake MCP gateway received no request"
    assert set(seen_auth) == {"Bearer exchanged-mcp-gateway"}
    assert not any(INCOMING_TOKEN in header for header in seen_auth)
    # Before load_skill no domain tool is visible; afterwards only the skill's allow-listed ones are.
    assert seen_tools[0] == ["load_skill", "render_ui"]
    assert "list_accounts" in seen_tools[1]
    assert "secret_admin_tool" not in seen_tools[1]
    assert "untrusted_data" in result.output


async def test_domain_errors_reach_the_model_without_spending_the_retry_budget(
    fake_gateway: tuple[str, Seen],
) -> None:
    gateway_url, _ = fake_gateway
    steps = [
        ToolCallPart("load_skill", {"name": "accounts"}),
        ToolCallPart("get_balance", {"account_id": "acc-x"}),
        ToolCallPart("get_balance", {"account_id": "acc-y"}),
    ]
    failures: list[str] = []

    def respond(messages: list[ModelMessage], _: AgentInfo) -> ModelResponse:
        failures.extend(str(p.content) for p in messages[-1].parts if isinstance(p, RetryPromptPart | ToolReturnPart))
        step = len(messages) // 2
        return ModelResponse(parts=[steps[step] if step < len(steps) else TextPart("No encontré esas cuentas.")])

    tools = banking_toolset(_exchanger(), gateway_url=gateway_url)
    agent = build_agent(FunctionModel(respond), skills=SkillRegistry.from_dir(SKILLS_DIR), domain_tools=[tools])

    result = await agent.run("¿Saldo de acc-x y acc-y?", deps=_deps())

    assert result.output == "No encontré esas cuentas."
    assert sum("account_not_found" in failure for failure in failures) == 2


async def test_a_run_that_loads_no_skill_contacts_neither_the_idp_nor_any_mcp_server(
    fake_gateway: tuple[str, Seen],
) -> None:
    gateway_url, seen = fake_gateway
    exchanged: list[str] = []
    tools = banking_toolset(_exchanger(exchanged), gateway_url=gateway_url)
    agent = build_agent(
        FunctionModel(lambda _m, _i: ModelResponse(parts=[TextPart("¡Hola!")])),
        skills=SkillRegistry.from_dir(SKILLS_DIR),
        domain_tools=[tools],
    )

    result = await agent.run("hola", deps=_deps())

    assert result.output == "¡Hola!"
    assert exchanged == []
    assert seen == []


async def test_loading_accounts_exchanges_once_for_the_gateway_and_closes_its_session(
    fake_gateway: tuple[str, Seen], monkeypatch: pytest.MonkeyPatch
) -> None:
    gateway_url, seen = fake_gateway
    exchanged: list[str] = []
    opened: list[MCPToolset[BotDeps]] = []
    enter = MCPToolset.__aenter__

    async def recording_enter(self: MCPToolset[BotDeps]) -> MCPToolset[BotDeps]:
        opened.append(self)
        return await enter(self)

    monkeypatch.setattr(MCPToolset, "__aenter__", recording_enter)
    tools = banking_toolset(_exchanger(exchanged), gateway_url=gateway_url)
    agent = build_agent(_scripted_model([]), skills=SkillRegistry.from_dir(SKILLS_DIR), domain_tools=[tools])

    await agent.run("¿Qué cuentas tengo?", deps=_deps())

    assert exchanged == ["mcp-gateway"]  # Never a backend audience: the gateway exchanges for those.
    assert seen
    assert {server for server, _ in seen} == {"fake-gateway"}
    sessions = {id(session): session for session in opened}.values()  # It re-enters itself per request.
    assert [session.id for session in sessions] == ["mcp-gateway"]
    assert not any(session.is_running for session in sessions)


@pytest.mark.parametrize("failure", ["idp_down", "mcp_unreachable"])
async def test_a_server_that_fails_to_connect_degrades_the_run_instead_of_failing_it(
    fake_gateway: tuple[str, Seen], caplog: pytest.LogCaptureFixture, failure: str
) -> None:
    gateway_url, seen = fake_gateway
    if failure == "mcp_unreachable":
        gateway_url = f"http://127.0.0.1:{_free_port()}/mcp"
    exchanger = _exchanger(status=500 if failure == "idp_down" else 200)
    seen_tools: list[list[str]] = []
    instructions: list[str] = []

    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen_tools.append(sorted(t.name for t in info.function_tools))
        instructions.append(info.instructions or "")
        if len(seen_tools) == 1:
            return ModelResponse(parts=[ToolCallPart("load_skill", {"name": "accounts"})])
        return ModelResponse(parts=[TextPart("El servicio no está disponible.")])

    tools = banking_toolset(exchanger, gateway_url=gateway_url)
    agent = build_agent(FunctionModel(respond), skills=SkillRegistry.from_dir(SKILLS_DIR), domain_tools=[tools])

    result = await agent.run("¿Qué cuentas tengo?", deps=BotDeps(user_id="ana", access_token=INCOMING_TOKEN))

    assert result.output == "El servicio no está disponible."
    assert "list_accounts" not in seen_tools[1]
    assert "unavailable right now: mcp-gateway" in instructions[1]
    assert "unavailable" not in instructions[0]
    assert seen == []  # The fake gateway is never reached, whichever hop failed.
    logged = [r for r in caplog.records if r.getMessage() == "mcp server unavailable"]
    assert [r.__dict__["server"] for r in logged] == ["mcp-gateway"]  # Once per run, not once per step.
    assert not any(INCOMING_TOKEN in str(r.__dict__) for r in caplog.records)


def test_every_skill_that_gates_the_gateway_exists() -> None:
    registry = SkillRegistry.from_dir(SKILLS_DIR)
    assert all(registry.get(name) for name in GATEWAY_NEEDED_BY)
