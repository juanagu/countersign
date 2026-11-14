import logging
from typing import Any

from pydantic import ValidationError
from pydantic_ai import Tool, ToolReturn
from pydantic_ai.toolsets import FunctionToolset

from app.chat.deps import BotDeps
from app.contracts.generated.a2ui_catalog import UiTree
from app.genui.a2ui import surface_event

logger = logging.getLogger(__name__)

RENDER_UI_TOOL = "render_ui"
INVALID_UI_METRIC = "a2ui.invalid_payload"
RENDERED = (
    "Shown to the customer under your text. Only if you haven't answered yet, add one short sentence; "
    "never refer to the card or repeat its figures."
)
DROPPED = "The UI was invalid and was not shown. Answer in plain text instead."

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


def genui_toolset() -> FunctionToolset[BotDeps]:
    # `from_schema` advertises the catalog schema to the model without validating arguments itself, so an invalid
    # tree reaches `render_ui` and degrades to text instead of triggering a model retry (security rule 5).
    tool: Tool[BotDeps] = Tool.from_schema(
        render_ui, name=RENDER_UI_TOOL, description=DESCRIPTION, json_schema=UiTree.model_json_schema()
    )
    return FunctionToolset([tool])
