import logging
from typing import Any

import pytest
from pydantic_ai import ToolReturn

from app.contracts.generated.a2ui_catalog import UiTree
from app.genui.a2ui import CATALOG_ID, OPERATIONS_KEY, surface_operations
from app.genui.render_ui import DROPPED, INVALID_UI_METRIC, render_ui

SPENDING: dict[str, Any] = {
    "title": "Gastos de octubre",
    "children": [
        {
            "component": "BarChart",
            "props": {"currency": "ARS", "bars": [{"label": "supermercado", "value": 152300.5}]},
        },
        {"component": "List", "props": {"items": [{"title": "Supermercado", "trailing": "$ 152.300,50"}]}},
    ],
}


def test_flattens_the_tree_under_a_root_card() -> None:
    ops = surface_operations(UiTree.model_validate(SPENDING), "s1")
    assert ops[0] == {"version": "v0.9", "createSurface": {"surfaceId": "s1", "catalogId": CATALOG_ID}}
    components = ops[1]["updateComponents"]["components"]
    assert components[0] == {"id": "root", "component": "Card", "children": ["c0", "c1"], "title": "Gastos de octubre"}
    assert components[1]["component"] == "BarChart"
    assert components[1]["bars"] == [{"label": "supermercado", "value": 152300.5}]
    assert components[2] == {"id": "c1", "component": "List", "items": SPENDING["children"][1]["props"]["items"]}


def test_a_valid_tree_returns_one_a2ui_activity() -> None:
    result = render_ui(**SPENDING)
    assert isinstance(result, ToolReturn)
    [event] = result.metadata
    assert event.activity_type == "a2ui-surface"
    assert len(event.content[OPERATIONS_KEY]) == 2


@pytest.mark.parametrize(
    "tree",
    [
        pytest.param({"children": [{"component": "PinInput", "props": {}}]}, id="component not in the catalog"),
        pytest.param({"children": [{"component": "Text", "props": {"text": "x", "onClick": "js"}}]}, id="extra prop"),
        pytest.param(
            {"children": [{"component": "BarChart", "props": {"bars": [{"label": "a", "value": -1}]}}]},
            id="negative bar",
        ),
        pytest.param({"children": []}, id="empty surface"),
        pytest.param({"title": "x" * 500, "children": [{"component": "Text", "props": {"text": "x"}}]}, id="too long"),
        pytest.param({"children": "not a list"}, id="wrong type"),
    ],
)
def test_an_invalid_tree_is_dropped_for_text_and_counted(
    tree: dict[str, Any], caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING):
        assert render_ui(**tree) == DROPPED
    assert any(getattr(record, "metric", None) == INVALID_UI_METRIC for record in caplog.records)


def test_the_per_currency_spending_card_the_accounts_skill_asks_for_is_valid() -> None:
    def section(currency: str, title: str, total: float, formatted: str) -> list[dict[str, Any]]:
        bars = [{"label": "compras", "value": total}]
        return [
            {"component": "BarChart", "props": {"title": title, "currency": currency, "bars": bars}},
            {"component": "List", "props": {"items": [{"title": "Compras", "trailing": formatted}]}},
        ]

    tree = {
        "title": "Gastos de octubre",
        "children": [
            *section("ARS", "En pesos", 80000.0, "$ 80.000,00"),
            *section("USD", "En dólares", 120.0, "US$ 120,00"),
        ],
    }
    components = surface_operations(UiTree.model_validate(tree), "s1")[1]["updateComponents"]["components"]
    assert [c.get("currency") for c in components if c["component"] == "BarChart"] == ["ARS", "USD"]
