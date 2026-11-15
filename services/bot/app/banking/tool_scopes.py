import re
from collections.abc import Mapping

# Keys under the MCP tool `_meta` where servers declare scopes (`@poc/mcp-kit` SCOPE_META_KEY, LIST_SCOPE_META_KEY).
SCOPE_META_KEY = "bank/scope"
LIST_SCOPE_META_KEY = "bank/listScope"
SCOPE_PATTERN = r"^[a-z]+:[a-z]+$"


def _valid_scope(value: object) -> str | None:
    return value if isinstance(value, str) and re.fullmatch(SCOPE_PATTERN, value) else None


def read_scope(meta: Mapping[str, object] | None) -> str | None:
    """The scope a token needs to call the tool, or None when it is missing or malformed."""
    return _valid_scope((meta or {}).get(SCOPE_META_KEY))


def read_list_scope(meta: Mapping[str, object] | None) -> str | None:
    """The scope a token needs to see the tool listed: `bank/listScope` when declared, else `bank/scope`."""
    meta = meta or {}
    if LIST_SCOPE_META_KEY in meta:
        return _valid_scope(meta[LIST_SCOPE_META_KEY]) if read_scope(meta) else None
    return read_scope(meta)
