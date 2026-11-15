from enum import IntEnum

# Key under the MCP tool `_meta` where servers declare the tier (`@poc/mcp-kit` RISK_TIER_META_KEY).
RISK_TIER_META_KEY = "bank/riskTier"


class RiskTier(IntEnum):
    """T0 public read, T1 personal read, T2 reversible write, T3 money movement."""

    T0 = 0
    T1 = 1
    T2 = 2
    T3 = 3

    @classmethod
    def parse(cls, value: object) -> "RiskTier | None":
        return cls.__members__.get(value) if isinstance(value, str) else None
