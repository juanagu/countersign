"""Builds A2UI v0.9 operations from a validated UiTree, in the AG-UI activity shape CopilotKit renders."""

from typing import Any
from uuid import uuid4

from ag_ui.core import ActivitySnapshotEvent, EventType

from app.contracts.generated.a2ui_catalog import UiTree

A2UI_VERSION = "v0.9"
# Must match the catalogId the web app registers (`apps/web/src/features/genui/catalog.tsx`).
CATALOG_ID = "bank-catalog-v1"
ACTIVITY_TYPE = "a2ui-surface"
OPERATIONS_KEY = "a2ui_operations"
ROOT_ID = "root"


def surface_operations(tree: UiTree, surface_id: str) -> list[dict[str, Any]]:
    """Flattens the tree into components: one root Card whose children are leaf components with bot-made ids."""
    children: list[dict[str, Any]] = []
    for index, node in enumerate(tree.children):
        component = node.root
        props = component.props.model_dump(mode="json", exclude_none=True)
        children.append({"id": f"c{index}", "component": component.component, **props})
    root = {"id": ROOT_ID, "component": "Card", "children": [child["id"] for child in children]}
    root.update(tree.model_dump(mode="json", include={"title", "subtitle"}, exclude_none=True))
    return [
        {"version": A2UI_VERSION, "createSurface": {"surfaceId": surface_id, "catalogId": CATALOG_ID}},
        {"version": A2UI_VERSION, "updateComponents": {"surfaceId": surface_id, "components": [root, *children]}},
    ]


def surface_event(tree: UiTree) -> ActivitySnapshotEvent:
    surface_id = f"surface-{uuid4()}"
    return ActivitySnapshotEvent(
        type=EventType.ACTIVITY_SNAPSHOT,
        message_id=str(uuid4()),
        activity_type=ACTIVITY_TYPE,
        content={OPERATIONS_KEY: surface_operations(tree, surface_id)},
    )
