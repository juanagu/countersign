from dataclasses import dataclass, field
from typing import Any

from pydantic_ai import RunContext
from pydantic_ai.toolsets import ToolsetTool, WrapperToolset

from app.chat.deps import BotDeps
from app.policy.frequency_caps import FrequencyCaps
from app.policy.policy_toolset import INPUT_BLOCKED, denied, tool_tier
from app.policy.risk_tier import RiskTier
from app.policy.tool_policy import NO_TIER


@dataclass
class DelegatePolicyToolset(WrapperToolset[BotDeps]):
    """The gate in front of the delegate tools, which no skill grants: each declares its tier in its metadata like
    any domain tool, waits for the input verdict above T0, and counts against the per-turn delegation cap in the
    conversation's shared `FrequencyCaps`. The subagent's own calls pass its own `PolicyToolset`."""

    caps: FrequencyCaps = field(default_factory=FrequencyCaps)
    names: frozenset[str] = frozenset()  # The delegate tool names, which the root policy and the routes are handed.

    async def call_tool(
        self, name: str, tool_args: dict[str, Any], ctx: RunContext[BotDeps], tool: ToolsetTool[BotDeps]
    ) -> Any:
        tier = tool_tier(tool)
        if tier is None:
            return denied(name, NO_TIER)
        if tier > RiskTier.T0 and (await ctx.deps.guard.input_verdict()).blocked:
            return denied(name, INPUT_BLOCKED)  # Starts no subagent and spends no tokens on one.
        if reason := self.caps.acquire_delegation((ctx.deps.user_id, ctx.deps.session_id), ctx.run_id or ""):
            return denied(name, reason)
        return await self.wrapped.call_tool(name, tool_args, ctx, tool)
