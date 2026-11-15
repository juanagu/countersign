import pytest

from app.banking.tool_scopes import LIST_SCOPE_META_KEY, SCOPE_META_KEY, read_list_scope, read_scope


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
    assert read_list_scope(meta) is None


def test_the_list_scope_falls_back_to_the_call_scope() -> None:
    assert read_list_scope({SCOPE_META_KEY: "accounts:read"}) == "accounts:read"


def test_reads_a_declared_list_scope() -> None:
    meta = {SCOPE_META_KEY: "transfers:execute", LIST_SCOPE_META_KEY: "transfers:prepare"}
    assert read_scope(meta) == "transfers:execute"
    assert read_list_scope(meta) == "transfers:prepare"


@pytest.mark.parametrize("list_scope", [None, "", "transfers", 3])
def test_a_malformed_list_scope_never_falls_back_to_the_call_scope(list_scope: object) -> None:
    assert read_list_scope({SCOPE_META_KEY: "transfers:execute", LIST_SCOPE_META_KEY: list_scope}) is None
