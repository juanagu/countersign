"""T3 tools pause for the customer's approval; the step-up token comes from the app, never the model."""

import json
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from pydantic_ai import DeferredToolRequests, DeferredToolResults, ToolApproved, ToolDenied
from pydantic_ai.messages import ModelMessage, ModelResponse, TextPart, ToolCallPart, ToolReturnPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.toolsets import FunctionToolset

from app.auth.token_verifier import JwksTokenVerifier
from app.chat.agent import BotAgent, build_agent
from app.chat.deps import BotDeps
from app.config import SKILLS_DIR, Settings
from app.main import create_app
from app.skills.registry import SkillRegistry
from tests.conftest import TEST_CLIENT_SECRET, TEST_MODEL, SigningKey

DRAFT_ID = "drf_0b3a6f9e-4c1d-4e2a-9f7b-1a2b3c4d5e6f"
RECEIPT: dict[str, Any] = {
    "transfer_id": "trf_1",
    "draft_id": DRAFT_ID,
    "reference": "BD-1",
    "executed_at": "2026-11-13T12:01:00.000Z",
    "amount": "50000.00",
    "fee": "0.00",
    "currency": "ARS",
    "source_account": {"id": "acc-juan-ars", "alias": "Cuenta corriente", "number": "****7810"},
    "beneficiary": {"id": "ben-juan-ana", "name": "Ana Gómez", "bank": "Banco Demo", "account": "****5211"},
}


class FakePayments:
    def __init__(self) -> None:
        self.executed: list[dict[str, Any]] = []
        self.toolset: FunctionToolset[BotDeps] = FunctionToolset()

        @self.toolset.tool_plain(metadata={"meta": {"bank/riskTier": "T3"}})
        def execute_transfer(draft_id: str, step_up_token: str = "") -> dict[str, Any]:
            self.executed.append({"draft_id": draft_id, "step_up_token": step_up_token})
            return RECEIPT


def _model(seen_schemas: list[dict[str, Any]], model_args: dict[str, Any] | None = None) -> FunctionModel:
    def respond(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        for tool in info.function_tools:
            if tool.name == "execute_transfer":
                seen_schemas.append(tool.parameters_json_schema)
        returns = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
        if not returns:
            return ModelResponse(parts=[ToolCallPart("load_skill", {"name": "payments"})])
        if len(returns) == 1:
            return ModelResponse(parts=[ToolCallPart("execute_transfer", model_args or {"draft_id": DRAFT_ID})])
        return ModelResponse(parts=[TextPart(json.dumps(returns[-1].content, default=str))])

    return FunctionModel(respond)


def _agent(fake: FakePayments, schemas: list[dict[str, Any]], model_args: dict[str, Any] | None = None) -> BotAgent:
    return build_agent(
        _model(schemas, model_args), skills=SkillRegistry.from_dir(SKILLS_DIR), domain_tools=[fake.toolset]
    )


def _deps(*skills: str) -> BotDeps:
    return BotDeps(user_id="juan", access_token="", loaded_skills=set(skills))


async def test_pauses_for_approval_and_never_shows_the_model_the_token_argument() -> None:
    fake, schemas = FakePayments(), []
    result = await _agent(fake, schemas).run("Mandale 50.000 a Ana", deps=_deps())

    assert isinstance(result.output, DeferredToolRequests)
    [approval] = result.output.approvals
    assert approval.tool_name == "execute_transfer"
    assert result.output.metadata[approval.tool_call_id]["draft_id"] == DRAFT_ID
    assert fake.executed == []
    assert schemas and all("step_up_token" not in schema.get("properties", {}) for schema in schemas)


async def test_executes_once_with_the_apps_token_after_approval() -> None:
    fake, schemas = FakePayments(), []
    agent = _agent(fake, schemas)
    paused = await agent.run("Mandale 50.000 a Ana", deps=_deps())
    assert isinstance(paused.output, DeferredToolRequests)
    call_id = paused.output.approvals[0].tool_call_id

    approved = ToolApproved(override_args={"draft_id": DRAFT_ID, "step_up_token": "step-up-from-the-app"})
    resumed = await agent.run(
        message_history=paused.all_messages(),
        deferred_tool_results=DeferredToolResults(approvals={call_id: approved}),
        # The route restores skills from the history's load_skill calls (tests/skills/test_history.py).
        deps=_deps("payments"),
    )

    assert fake.executed == [{"draft_id": DRAFT_ID, "step_up_token": "step-up-from-the-app"}]
    assert "BD-1" in str(resumed.output)


async def test_a_denial_executes_nothing() -> None:
    fake, schemas = FakePayments(), []
    agent = _agent(fake, schemas)
    paused = await agent.run("Mandale 50.000 a Ana", deps=_deps())
    assert isinstance(paused.output, DeferredToolRequests)
    call_id = paused.output.approvals[0].tool_call_id

    await agent.run(
        message_history=paused.all_messages(),
        deferred_tool_results=DeferredToolResults(approvals={call_id: ToolDenied("El cliente canceló.")}),
        deps=_deps("payments"),
    )
    assert fake.executed == []


async def test_a_model_supplied_token_on_a_non_approval_tool_is_refused() -> None:
    toolset: FunctionToolset[BotDeps] = FunctionToolset()
    calls: list[str] = []

    @toolset.tool_plain(metadata={"meta": {"bank/riskTier": "T1"}})
    def list_beneficiaries(step_up_token: str = "") -> str:
        calls.append(step_up_token)
        return "ok"

    def respond(messages: list[ModelMessage], _: AgentInfo) -> ModelResponse:
        returns = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
        if not returns:
            return ModelResponse(parts=[ToolCallPart("load_skill", {"name": "payments"})])
        if len(returns) == 1:
            return ModelResponse(parts=[ToolCallPart("list_beneficiaries", {"step_up_token": "forged"})])
        return ModelResponse(parts=[TextPart(json.dumps(returns[-1].content))])

    agent = build_agent(FunctionModel(respond), skills=SkillRegistry.from_dir(SKILLS_DIR), domain_tools=[toolset])
    result = await agent.run("x", deps=_deps())
    assert calls == []
    assert "policy_denied" in str(result.output)


@pytest.mark.filterwarnings("ignore::UserWarning")
async def test_the_ag_ui_run_ends_as_an_interrupt_naming_the_draft(
    signing_key: SigningKey, verifier: JwksTokenVerifier
) -> None:
    from pydantic_ai.models.function import DeltaToolCall

    async def stream(messages: list[ModelMessage], _: AgentInfo):  # type: ignore[no-untyped-def]
        returns = [p for m in messages for p in getattr(m, "parts", []) if isinstance(p, ToolReturnPart)]
        if not returns:
            yield {0: DeltaToolCall(name="load_skill", json_args=json.dumps({"name": "payments"}))}
        else:
            yield {0: DeltaToolCall(name="execute_transfer", json_args=json.dumps({"draft_id": DRAFT_ID}))}

    fake = FakePayments()
    agent = build_agent(
        FunctionModel(stream_function=stream), skills=SkillRegistry.from_dir(SKILLS_DIR), domain_tools=[fake.toolset]
    )
    app = create_app(
        Settings(bot_model=TEST_MODEL, bot_client_secret=TEST_CLIENT_SECRET), agent=agent, token_verifier=verifier
    )
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
    finished = events[-1]
    assert finished["type"] == "RUN_FINISHED"
    assert finished["outcome"]["type"] == "interrupt"
    [interrupt] = finished["outcome"]["interrupts"]
    assert interrupt["metadata"]["draft_id"] == DRAFT_ID
    assert fake.executed == []
