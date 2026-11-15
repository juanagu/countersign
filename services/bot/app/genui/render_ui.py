import logging
from collections.abc import Sequence
from typing import Any

from pydantic import ValidationError
from pydantic_ai import RunContext, Tool, ToolReturn
from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.toolsets import FunctionToolset

from app.chat.deps import BotDeps
from app.contracts.generated.a2ui_catalog import UiTree
from app.genui.a2ui import surface_event

logger = logging.getLogger(__name__)

RENDER_UI_TOOL = "render_ui"
INVALID_UI_METRIC = "a2ui.invalid_payload"
RENDERED = (
    "Shown to the customer under your text. A card is never the answer: if you haven't written your full answer "
    "in text yet, write it now. Never refer to the card."
)
DROPPED = "The UI was invalid and was not shown. Answer in plain text instead."
UNANSWERED = (
    "Shown, under your text. The customer has not read any answer yet: the card only holds data or sources. "
    "Now write your full answer to their question in text, with its figures. Never refer to the card."
)

DESCRIPTION = """\
Show the customer a card built from catalog components: Text, KeyValueList, List, BarChart, Table,
Button, Citation, QuickReplies. Use it for structured data (spending by category, lists of movements,
sources). Every value must come from a tool result in this conversation. Never use it for transfer
confirmations or receipts: those cards are shown automatically."""


def render_ui(**tree: Any) -> ToolReturn | str:
    """Validates the tree against the catalog; an invalid one is dropped and the model falls back to text."""
    try:
        valid = UiTree.model_validate(tree)
    except ValidationError as error:
        logger.warning(
            "dropped invalid a2ui payload", extra={"metric": INVALID_UI_METRIC, "errors": error.error_count()}
        )
        return DROPPED
    return ToolReturn(return_value=RENDERED, metadata=[surface_event(valid)])


def answered_in_text(messages: Sequence[ModelMessage]) -> bool:
    """Whether the model wrote answer text since the customer's last message (the current response included)."""
    for message in reversed(messages):
        if isinstance(message, ModelRequest) and any(isinstance(part, UserPromptPart) for part in message.parts):
            return False
        if isinstance(message, ModelResponse) and any(
            isinstance(part, TextPart) and part.content.strip() for part in message.parts
        ):
            return True
    return False


def render_ui_after_answer(ctx: RunContext[BotDeps], **tree: Any) -> ToolReturn | str:
    """A card is never the answer (F28): drawn before any answer text, the model is told to write the answer now.

    The card is still shown (the output guard places it under the text), so its sources are never lost.
    """
    result = render_ui(**tree)
    if isinstance(result, ToolReturn) and not answered_in_text(ctx.messages):
        return ToolReturn(return_value=UNANSWERED, metadata=result.metadata)
    return result


def genui_toolset() -> FunctionToolset[BotDeps]:
    # `from_schema` advertises the catalog schema to the model without validating arguments itself, so an invalid
    # tree reaches `render_ui` and degrades to text instead of triggering a model retry (security rule 5).
    tool: Tool[BotDeps] = Tool.from_schema(
        render_ui_after_answer,
        name=RENDER_UI_TOOL,
        description=DESCRIPTION,
        json_schema=UiTree.model_json_schema(),
        takes_ctx=True,
    )
    return FunctionToolset([tool])
