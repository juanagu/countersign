import pytest

from app.policy.tool_scopes import SCOPE_META_KEY, read_scope


def test_reads_a_valid_scope() -> None:
    assert read_scope({SCOPE_META_KEY: "accounts:read"}) == "accounts:read"


@pytest.mark.parametrize(
    "meta",
    [
        None,
        {},
        {SCOPE_META_KEY: None},
        {SCOPE_META_KEY: ["accounts:read"]},
        {SCOPE_META_KEY: ""},
        {SCOPE_META_KEY: "accounts"},
        {SCOPE_META_KEY: "Accounts:Read"},
        {SCOPE_META_KEY: "accounts:read:all"},
        {SCOPE_META_KEY: "accounts:read transfers:execute"},
        {SCOPE_META_KEY: "accounts:read\n"},
    ],
)
def test_refuses_a_missing_or_malformed_scope(meta: dict[str, object] | None) -> None:
    assert read_scope(meta) is None
