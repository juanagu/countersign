from functools import cached_property, partial
from http import HTTPStatus

from fastapi import APIRouter, Request, Response
from pydantic import ValidationError
from pydantic_ai import CancellationToken, DeferredToolRequests
from pydantic_ai.conversation_store import ConversationStore
from pydantic_ai.messages import ModelMessage
from pydantic_ai.toolsets import AbstractToolset
from pydantic_ai.ui.ag_ui import AGUIAdapter

from app.auth.dependencies import CurrentPrincipal
from app.chat.agent import BotAgent
from app.chat.deps import BotDeps
from app.chat.interrupt_answers import resumed_calls, without_interrupt_answers
from app.conversations.history import conversation_id_for, load_thread, new_turn
from app.conversations.run_store import RunConversationStore
from app.core.llm.run_record import start_run_record
from app.guardrails.history_guard import grounds_no_figure
from app.guardrails.messages import (
    customer_spoke_since_last_response,
    customer_texts,
    redact_customer_turns,
    tool_results_in,
    tools_returned_in,
)
from app.guardrails.pending_approvals import recording_interrupts
from app.guardrails.pipeline import Guardrails
from app.guardrails.run_guard import RunGuard
from app.guardrails.stream import guarded_stream, refusal_shown
from app.policy.policy_toolset import THIRD_PARTY_TEXT_TOOLS
from app.skills.history import skills_loaded_in
from app.skills.registry import SkillRegistry


class BankAGUIAdapter(AGUIAdapter[BotDeps, str | DeferredToolRequests]):
    """Ignores tools declared by the client, drops its interrupt answers, and masks PII in the customer's turns."""

    @property
    def toolset(self) -> AbstractToolset[BotDeps] | None:
        return None  # The browser is untrusted and must not add callable tools.

    @cached_property
    def messages(self) -> list[ModelMessage]:
        client = without_interrupt_answers(self.run_input.messages, resumed_calls(self))
        return redact_customer_turns(self.load_messages(client, preserve_file_data=self.preserve_file_data))


def _invalid_body(error: ValidationError) -> Response:
    content = error.json(include_input=False)  # Never echo the body: it may carry personal data.
    return Response(content=content, media_type="application/json", status_code=HTTPStatus.UNPROCESSABLE_ENTITY)


def _start_guard(
    guardrails: Guardrails, user_id: str, history: list[ModelMessage], *, genuine_resume: bool
) -> RunGuard:
    return guardrails.start_run(
        user_id=user_id,
        customer_messages=customer_texts(history),
        third_party_text_seen=bool(tools_returned_in(history) & THIRD_PARTY_TEXT_TOOLS),
        earlier_tool_results=tool_results_in(history, excluding=grounds_no_figure),
        resume_only=genuine_resume and not customer_spoke_since_last_response(history),
    )


def chat_router(agent: BotAgent, skills: SkillRegistry, guardrails: Guardrails, store: ConversationStore) -> APIRouter:
    router = APIRouter()

    @router.post("/agent")
    async def run_agent(request: Request, principal: CurrentPrincipal) -> Response:
        # The stored conversation is the history; the client contributes only its new turn (ADR 015).
        try:
            adapter = await BankAGUIAdapter.from_request(
                request, agent=agent, conversation_store=store, conversation_scope=principal.user_id
            )
        except ValidationError as error:
            return _invalid_body(error)
        run = adapter.run_input
        stored = await load_thread(store, principal.user_id, run.thread_id)
        history = [*stored.messages, *new_turn(adapter.messages, awaiting_results=stored.awaiting_results)]
        conversation = (principal.user_id, run.thread_id)
        # A client-built resume proves nothing: only answering an interrupt raised here skips the classifier.
        resumed = resumed_calls(adapter)
        genuine_resume = bool(resumed) and guardrails.pending_approvals.consume(conversation, resumed)
        start_run_record()  # Before the guard and the run start their tasks, so both report to it (ADR 018).
        guard = _start_guard(guardrails, principal.user_id, history, genuine_resume=genuine_resume)
        deps = BotDeps(
            user_id=principal.user_id,
            access_token=principal.token,
            loaded_skills={name for name in skills_loaded_in(history) if skills.get(name)},
            session_id=run.thread_id,
            guard=guard,
        )
        # Saved as the guard released it: a refused run keeps the customer's turn and the refusal, not the answer.
        adapter.conversation_store = RunConversationStore(store, refusal=partial(refusal_shown, guard))
        token = CancellationToken()
        try:
            events = adapter.run_stream(
                deps=deps,
                cancellation_token=token,
                conversation_id=conversation_id_for(principal.user_id, run.thread_id),
            )
        except BaseException:
            guard.cancel()
            raise
        guarded = guarded_stream(events, guard, thread_id=run.thread_id, run_id=run.run_id, cancel_run=token.cancel)
        return adapter.streaming_response(recording_interrupts(guarded, guardrails.pending_approvals, conversation))

    return router
