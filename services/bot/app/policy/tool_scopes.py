import re
from collections.abc import Mapping

# Key under the MCP tool `_meta` where servers declare the scope a call needs (`@poc/mcp-kit` SCOPE_META_KEY).
SCOPE_META_KEY = "bank/scope"
SCOPE_PATTERN = r"^[a-z]+:[a-z]+$"

# Scopes only an approved call's own token may hold: a skill that asked for one would put it on a session token.
APPROVAL_ONLY_SCOPES = frozenset({"transfers:execute"})


def read_scope(meta: Mapping[str, object] | None) -> str | None:
    """The scope a token needs to call the tool, or None when it is missing or malformed."""
    value = (meta or {}).get(SCOPE_META_KEY)
    return value if isinstance(value, str) and re.fullmatch(SCOPE_PATTERN, value) else None
