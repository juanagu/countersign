"""The agent → policy → MCP path over real HTTP, against a fake MCP server that records what it receives."""

import asyncio
import json
import socket
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
import uvicorn
from fastmcp import FastMCP
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from starlette.types import ASGIApp, Receive, Scope, Send

from app.banking.mcp_toolsets import banking_toolset
from app.banking.token_exchange import TokenExchanger
from app.chat.agent import build_agent
from app.chat.deps import BotDeps
from app.config import SKILLS_DIR
from app.skills.registry import SkillRegistry

INCOMING_TOKEN = "incoming-aud-bot-token"


class RecordAuth:
    def __init__(self, app: ASGIApp, seen: list[str]):
        self.app, self.seen = app, seen

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            self.seen.append(dict(scope["headers"]).get(b"authorization", b"").decode())
        await self.app(scope, receive, send)


def _fake_accounts_server() -> FastMCP:
    mcp = FastMCP("fake-accounts")

    @mcp.tool(meta={"bank/riskTier": "T1"})
    def list_accounts() -> dict[str, Any]:
        return {"accounts": [{"id": "acc-ana-ars", "currency": "ARS"}]}

    @mcp.tool(meta={"bank/riskTier": "T1"})
    def secret_admin_tool() -> str:
        return "should never be callable"

    return mcp


def _fake_payments_server() -> FastMCP:
    mcp = FastMCP("fake-payments")

    @mcp.tool(meta={"bank/riskTier": "T1"})
    def list_beneficiaries() -> dict[str, Any]:
        return {"beneficiaries": []}

    return mcp


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest.fixture
async def fake_servers() -> AsyncIterator[tuple[str, str, list[str]]]:
    seen: list[str] = []
    servers, urls = [], []
    for fake in (_fake_accounts_server(), _fake_payments_server()):
        port = _free_port()
        app = RecordAuth(fake.http_app(path="/mcp", stateless_http=True, json_response=True), seen)
        servers.append(uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")))
        urls.append(f"http://127.0.0.1:{port}/mcp")
    tasks = [asyncio.create_task(server.serve()) for server in servers]
    while not all(server.started for server in servers):  # noqa: ASYNC110 (uvicorn exposes no started event)
        await asyncio.sleep(0.01)
    yield urls[0], urls[1], seen
    for server in servers:
        server.should_exit = True
    await asyncio.gather(*tasks)


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
    fake_servers: tuple[str, str, list[str]],
) -> None:
    accounts_url, payments_url, seen_auth = fake_servers

    def token_endpoint(request: httpx.Request) -> httpx.Response:
        audience = dict(httpx.QueryParams(request.content.decode()))["audience"]
        return httpx.Response(
            200, json={"access_token": f"exchanged-{audience}", "expires_in": 300, "token_type": "Bearer"}
        )

    exchanger = TokenExchanger(
        httpx.AsyncClient(transport=httpx.MockTransport(token_endpoint)),
        token_url="http://idp.test/token",
        client_id="bot",
        client_secret="s3cret",
    )
    seen_tools: list[list[str]] = []
    tools = banking_toolset(exchanger, accounts_url=accounts_url, payments_url=payments_url)
    agent = build_agent(_scripted_model(seen_tools), skills=SkillRegistry.from_dir(SKILLS_DIR), domain_tools=[tools])

    result = await agent.run("¿Qué cuentas tengo?", deps=BotDeps(user_id="ana", access_token=INCOMING_TOKEN))

    assert seen_auth, "the fake MCP server received no request"
    assert all(header in {"Bearer exchanged-mcp-accounts", "Bearer exchanged-mcp-payments"} for header in seen_auth)
    assert not any(INCOMING_TOKEN in header for header in seen_auth)
    # Before load_skill no domain tool is visible; afterwards only the skill's allow-listed ones are.
    assert seen_tools[0] == ["load_skill"]
    assert "list_accounts" in seen_tools[1]
    assert "secret_admin_tool" not in seen_tools[1]
    assert "untrusted_data" in result.output
