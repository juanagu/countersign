from functools import cached_property
from http import HTTPStatus

from fastapi import APIRouter, Request, Response
from pydantic import ValidationError
from pydantic_ai import CancellationToken, DeferredToolRequests, UserError
from pydantic_ai.messages import ModelMessage
from pydantic_ai.toolsets import AbstractToolset
from pydantic_ai.ui.ag_ui import AGUIAdapter

from app.auth.dependencies import CurrentPrincipal
from app.chat.agent import BotAgent
from app.chat.deps import BotDeps
from app.chat.interrupt_answers import without_interrupt_answers
from app.genui.render_ui import RENDER_UI_TOOL
from app.guardrails.messages import (
    customer_spoke_since_last_response,
    customer_texts,
    redact_customer_turns,
    tool_results_in,
    tools_returned_in,
)
from app.guardrails.pipeline import Guardrails
from app.guardrails.stream import guarded_stream
from app.policy.policy_toolset import THIRD_PARTY_TEXT_TOOLS
from app.skills.history import LOAD_SKILL, skills_loaded_in
from app.skills.registry import SkillRegistry

# Their results are instructions or UI, not bank data: like in a run (`PolicyToolset`), they ground no figure.
NON_EVIDENCE_TOOLS = frozenset({LOAD_SKILL, RENDER_UI_TOOL})


class BankAGUIAdapter(AGUIAdapter[BotDeps, str | DeferredToolRequests]):
    """Ignores tools declared by the client, drops its interrupt answers, and masks PII in the customer's turns."""

    @property
    def toolset(self) -> AbstractToolset[BotDeps] | None:
        return None  # The browser is untrusted and must not add callable tools.

    @cached_property
    def resumed_calls(self) -> frozenset[str]:
        """The tool call ids this run's `resume` entries answer."""
        try:
            results = self.deferred_tool_results
        except UserError:
            return frozenset()  # Malformed: the run stream reports it to the client as a RUN_ERROR.
        return frozenset(results.approvals) if results else frozenset()

    @cached_property
    def messages(self) -> list[ModelMessage]:
        client = without_interrupt_answers(self.run_input.messages, self.resumed_calls)
        return redact_customer_turns(self.load_messages(client, preserve_file_data=self.preserve_file_data))


def _invalid_body(error: ValidationError) -> Response:
    content = error.json(include_input=False)  # Never echo the body: it may carry personal data.
    return Response(content=content, media_type="application/json", status_code=HTTPStatus.UNPROCESSABLE_ENTITY)


def chat_router(agent: BotAgent, skills: SkillRegistry, guardrails: Guardrails) -> APIRouter:
    router = APIRouter()

    @router.post("/agent")
    async def run_agent(request: Request, principal: CurrentPrincipal) -> Response:
        try:
            adapter = await BankAGUIAdapter.from_request(request, agent=agent)
        except ValidationError as error:
            return _invalid_body(error)
        body = await request.json()  # Starlette caches it; the adapter read the same body.
        raw_messages = body.get("messages") if isinstance(body, dict) else None
        restored = skills_loaded_in(raw_messages if isinstance(raw_messages, list) else [])
        history = adapter.messages
        guard = guardrails.start_run(
            user_id=principal.user_id,
            customer_messages=customer_texts(history),
            third_party_text_seen=bool(tools_returned_in(history) & THIRD_PARTY_TEXT_TOOLS),
            earlier_tool_results=tool_results_in(history, excluding=NON_EVIDENCE_TOOLS),
            resume_only=bool(adapter.run_input.resume) and not customer_spoke_since_last_response(history),
        )
        deps = BotDeps(
            user_id=principal.user_id,
            access_token=principal.token,
            loaded_skills={name for name in restored if skills.get(name)},
            session_id=adapter.run_input.thread_id,
            guard=guard,
        )
        token = CancellationToken()
        try:
            events = adapter.run_stream(deps=deps, cancellation_token=token)
        except BaseException:
            guard.cancel()
            raise
        run = adapter.run_input
        guarded = guarded_stream(events, guard, thread_id=run.thread_id, run_id=run.run_id, cancel_run=token.cancel)
        return adapter.streaming_response(guarded)

    return router
