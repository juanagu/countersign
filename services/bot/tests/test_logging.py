import logging

import pytest

from app.core.logging import resolve_level


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("trace", logging.DEBUG),
        ("fatal", logging.CRITICAL),
        ("debug", logging.DEBUG),
        ("WARNING", logging.WARNING),
        ("error", logging.ERROR),
        ("loud", logging.INFO),
        ("", logging.INFO),
    ],
)
def test_resolves_levels_shared_with_the_node_services(name: str, expected: int) -> None:
    assert resolve_level(name) == expected
