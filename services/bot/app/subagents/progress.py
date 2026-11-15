"""A subagent's tool calls, relayed to the client by name only so its progress line shows ("Preparando la
transferencia…"). Arguments and results stay in the bot: they are customer data and third-party text."""

from dataclasses import dataclass
from typing import Literal

from ag_ui.core import BaseEvent, EventType, ToolCallEndEvent, ToolCallResultEvent, ToolCallStartEvent
from pydantic_ai import CustomEvent, RunContext
from pydantic_ai.messages import AgentStreamEvent, FunctionToolCallEvent, FunctionToolResultEvent

from app.chat.deps import BotDeps

Stage = Literal["start", "end", "result"]


@dataclass(kw_only=True)
class SubagentToolProgress(CustomEvent):
    """One stage of one subagent tool call. The AG-UI adapter sends its payload verbatim."""

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


class ToolProgressRelay:
    """Emits each subagent tool call into the orchestrator's event stream, from the delegate tool's context."""

    def __init__(self, ctx: RunContext[BotDeps]) -> None:
        self._ctx = ctx
        self._open: dict[str, str] = {}

    async def on(self, event: AgentStreamEvent) -> None:
        if isinstance(event, FunctionToolCallEvent):
            self._open[event.part.tool_call_id] = event.part.tool_name
            await self._emit("start", event.part.tool_call_id, event.part.tool_name)
        elif isinstance(event, FunctionToolResultEvent) and event.tool_call_id in self._open:
            await self._close(event.tool_call_id)

    async def close_open_calls(self) -> None:
        """A run that failed mid-call still ends each line it started."""
        for call_id in list(self._open):
            await self._close(call_id)

    async def _close(self, call_id: str) -> None:
        tool = self._open.pop(call_id)
        await self._emit("end", call_id, tool)
        await self._emit("result", call_id, tool)

    async def _emit(self, stage: Stage, call_id: str, tool: str) -> None:
        await self._ctx.emit(SubagentToolProgress(stage=stage, call_id=call_id, tool=tool))
