"""One status call that spans a subagent's whole run, so the client's progress line shows while it works
("Preparando la transferencia…"). It carries the delegate's name only: the request, the reply and the subagent's own
tool calls stay in the bot, as customer data and model text."""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Literal
from uuid import uuid4

from ag_ui.core import BaseEvent, EventType, ToolCallEndEvent, ToolCallResultEvent, ToolCallStartEvent
from pydantic_ai import CustomEvent, RunContext

from app.chat.deps import BotDeps

Stage = Literal["start", "end", "result"]


@dataclass(kw_only=True)
class DelegationStatus(CustomEvent):
    """One stage of the status call. The AG-UI adapter sends its payload verbatim."""

    stage: Stage
    call_id: str
    tool: str

    def to_payload(self) -> BaseEvent:
        if self.stage == "start":
            return ToolCallStartEvent(
                type=EventType.TOOL_CALL_START, tool_call_id=self.call_id, tool_call_name=self.tool
            )
        if self.stage == "end":
            return ToolCallEndEvent(type=EventType.TOOL_CALL_END, tool_call_id=self.call_id)
        # Empty: the client marks the call done, and so its line goes away, only once a result arrives.
        return ToolCallResultEvent(
            type=EventType.TOOL_CALL_RESULT,
            message_id=f"{self.call_id}-result",
            tool_call_id=self.call_id,
            content="",
            role="tool",
        )


@asynccontextmanager
async def delegation_status(ctx: RunContext[BotDeps], tool: str) -> AsyncIterator[None]:
    """Opens the status call under a fresh id, never the delegate's own, whose events stay withheld; the output guard
    lets it out only because its id is in `RunGuard.status_calls`. It closes however the run ends."""
    call_id = f"status-{uuid4().hex}"
    ctx.deps.guard.status_calls.add(call_id)
    await _emit(ctx, "start", call_id, tool)
    try:
        yield
    finally:
        await _emit(ctx, "end", call_id, tool)
        await _emit(ctx, "result", call_id, tool)


async def _emit(ctx: RunContext[BotDeps], stage: Stage, call_id: str, tool: str) -> None:
    await ctx.emit(DelegationStatus(stage=stage, call_id=call_id, tool=tool))
