"""SkillGatedMCPToolset's session and approved-call handling, against fake sessions and a fake exchanger."""

import json
import logging
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic_ai import ToolFailed

from app.banking.mcp_toolsets import SkillGatedMCPToolset
from app.banking.token_exchange import TokenExchangeError
from app.chat.deps import BotDeps

ACCOUNTS = frozenset({"accounts:read"})
PAYMENTS = frozenset({"accounts:read", "transfers:prepare"})
EXECUTE = frozenset({"transfers:execute"})
SCOPES_BY_SKILL = {"accounts": ACCOUNTS, "payments": PAYMENTS}


def _tool(tier: str, scope: str) -> Any:
    return SimpleNamespace(tool_def=SimpleNamespace(metadata={"meta": {"bank/riskTier": tier, "bank/scope": scope}}))


class FakeSession:
    def __init__(self, token: str, log: list[str], enter_error: Exception | None = None):
        self.token, self.log, self.enter_error = token, log, enter_error
        self.calls: list[str] = []
        self.closed = False

    async def __aenter__(self) -> "FakeSession":
        if self.enter_error:
            raise self.enter_error
        self.log.append(f"open {self.token}")
        return self

    async def __aexit__(self, *args: object) -> None:
        self.closed = True
        self.log.append(f"close {self.token}")

    async def get_tools(self, ctx: object) -> dict[str, Any]:
        return {"list_accounts": _tool("T1", "accounts:read")}

    async def call_tool(self, name: str, args: dict[str, Any], ctx: object, tool: object) -> str:
        self.calls.append(self.token)
        return f"{name} ok"


class FakeExchanger:
    def __init__(self, fail_for: frozenset[str] | None = None, error: Exception | None = None):
        self.exchanges: list[frozenset[str]] = []
        self.fail_for, self.error = fail_for, error or TokenExchangeError("refused", "invalid_scope")

    async def token_for(self, subject_token: str, audience: str, scopes: frozenset[str]) -> str:
        self.exchanges.append(scopes)
        if scopes == self.fail_for:
            raise self.error
        return "tok:" + ",".join(sorted(scopes))


class Harness:
    def __init__(self, exchanger: FakeExchanger, enter_error_for: str | None = None):
        self.log: list[str] = []
        self.sessions: list[FakeSession] = []
        self.enter_error_for = enter_error_for
        self.exchanger = exchanger
        self.toolset: Any = SkillGatedMCPToolset(self._open, exchanger, SCOPES_BY_SKILL)  # type: ignore[arg-type]

    def _open(self, token: str) -> FakeSession:
        error = ConnectionError("down") if token == self.enter_error_for else None
        session = FakeSession(token, self.log, error)
        self.sessions.append(session)
        return session


def _ctx(*skills: str, approved: bool = False) -> Any:
    deps = BotDeps(user_id="ana", access_token="incoming", loaded_skills=set(skills))
    return SimpleNamespace(deps=deps, tool_call_approved=approved)


async def test_a_failed_growth_exchange_keeps_the_tools_that_were_working() -> None:
    harness = Harness(FakeExchanger(fail_for=PAYMENTS))
    ctx = _ctx("accounts")
    assert set(await harness.toolset.get_tools(ctx)) == {"list_accounts"}

    ctx.deps.loaded_skills.add("payments")
    tools = await harness.toolset.get_tools(ctx)

    assert set(tools) == {"list_accounts"}
    assert not ctx.deps.unavailable_servers
    [session] = harness.sessions
    assert not session.closed
    assert await harness.toolset.call_tool("list_accounts", {}, ctx, tools["list_accounts"]) == "list_accounts ok"


async def test_growth_opens_the_wider_session_before_closing_the_old_one() -> None:
    harness = Harness(FakeExchanger())
    ctx = _ctx("accounts")
    await harness.toolset.get_tools(ctx)
    ctx.deps.loaded_skills.add("payments")
    await harness.toolset.get_tools(ctx)

    assert harness.log == [
        "open tok:accounts:read",
        "open tok:accounts:read,transfers:prepare",
        "close tok:accounts:read",
    ]


@pytest.mark.parametrize("failure", ["exchange", "open"])
async def test_a_failure_before_the_approved_call_is_sent_is_service_unavailable(
    failure: str, caplog: pytest.LogCaptureFixture
) -> None:
    exchanger = FakeExchanger(fail_for=EXECUTE if failure == "exchange" else None)
    harness = Harness(exchanger, enter_error_for="tok:transfers:execute" if failure == "open" else None)
    caplog.set_level(logging.WARNING)

    with pytest.raises(ToolFailed) as raised:
        await harness.toolset.call_tool(
            "execute_transfer", {}, _ctx("payments", approved=True), _tool("T3", "transfers:execute")
        )

    assert json.loads(str(raised.value)) == {"error": "service_unavailable", "service": "mcp-gateway"}
    assert all(not session.calls for session in harness.sessions)
    if failure == "exchange":
        [record] = [r for r in caplog.records if r.getMessage() == "approved call setup failed"]
        assert record.__dict__["oauth_error"] == "invalid_scope"


async def test_an_approved_call_that_fails_mid_flight_still_propagates() -> None:
    harness = Harness(FakeExchanger())

    async def boom(*args: object) -> str:
        raise RuntimeError("connection reset")

    original = FakeSession.call_tool
    FakeSession.call_tool = boom  # type: ignore[assignment,method-assign]
    try:
        with pytest.raises(RuntimeError, match="connection reset"):
            await harness.toolset.call_tool(
                "execute_transfer", {}, _ctx("payments", approved=True), _tool("T3", "transfers:execute")
            )
    finally:
        FakeSession.call_tool = original  # type: ignore[method-assign]
    assert harness.sessions[0].closed


async def test_an_approved_non_t3_call_goes_out_on_the_session_token() -> None:
    harness = Harness(FakeExchanger())
    ctx = _ctx("accounts", approved=True)
    await harness.toolset.get_tools(ctx)

    # transfers:prepare is not in the accounts session, but only a T3 call earns its own token.
    await harness.toolset.call_tool("prepare_transfer", {}, ctx, _tool("T2", "transfers:prepare"))

    assert harness.exchanger.exchanges == [ACCOUNTS]
    assert harness.sessions[0].calls == ["tok:accounts:read"]
