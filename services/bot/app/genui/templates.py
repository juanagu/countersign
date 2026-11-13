"""Server templates: transactional cards whose data comes from MCP results through code (security rule 4)."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from ag_ui.core import ActivitySnapshotEvent, EventType
from pydantic import BaseModel, ValidationError
from pydantic_ai import RunContext, ToolReturn
from pydantic_ai.toolsets import ToolsetTool, WrapperToolset

from app.chat.deps import BotDeps
from app.contracts.generated.bank_templates import TransferConfirmData, TransferConfirmTemplate

ACTIVITY_TYPE = "bank-template"

TemplateBuilder = Callable[[Mapping[str, Any]], BaseModel]


def transfer_confirm(draft: Mapping[str, Any]) -> TransferConfirmTemplate:
    """Maps the `prepare_transfer` result (snake_case MCP output) to the confirm card's data."""
    source, beneficiary = draft["source_account"], draft["beneficiary"]
    data = TransferConfirmData(
        draftId=draft["draft_id"],
        amount=draft["amount"],
        fee=draft["fee"],
        total=draft["total"],
        currency=draft["currency"],
        sourceAccount={"alias": source["alias"], "number": source["number"]},
        beneficiaryId=beneficiary["id"],
        beneficiary={"name": beneficiary["name"], "bank": beneficiary.get("bank"), "account": beneficiary["account"]},
        expiresAt=draft["expires_at"],
    )
    return TransferConfirmTemplate(
        template="transfer-confirm", version=1, surfaceId=f"draft-{data.draftId}", nonce=str(uuid4()), data=data
    )


DEFAULT_TEMPLATES: Mapping[str, TemplateBuilder] = {"prepare_transfer": transfer_confirm}


def template_event(template: BaseModel) -> ActivitySnapshotEvent:
    return ActivitySnapshotEvent(
        type=EventType.ACTIVITY_SNAPSHOT,
        message_id=str(uuid4()),
        activity_type=ACTIVITY_TYPE,
        content=template.model_dump(mode="json", exclude_none=True),
    )


@dataclass
class TemplateToolset(WrapperToolset[BotDeps]):
    """Attaches a server-template card to the results of the tools that have one."""

    templates: Mapping[str, TemplateBuilder] = field(default_factory=lambda: DEFAULT_TEMPLATES)

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[BotDeps], tool: ToolsetTool[BotDeps]
    ) -> Any:
        result = await self.wrapped.call_tool(name, tool_args, ctx, tool)
        builder = self.templates.get(name)
        if builder is None or not isinstance(result, Mapping) or "error" in result:
            return result
        try:
            template = builder(result)
        except (KeyError, TypeError, ValidationError):
            return result  # A result without the card's fields shows no card; the model still sees the data.
        return ToolReturn(return_value=result, metadata=[template_event(template)])
