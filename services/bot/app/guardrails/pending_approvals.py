"""The approval interrupts this bot raised, per user and thread, so only a genuine resume skips the classifier.

In memory, one bot process, like the frequency caps: a restart or a second replica forgets them, and the resume
is then classified as usual, which fails safe.
"""

import time
from collections.abc import AsyncIterator, Callable, Collection
from dataclasses import dataclass, field

from ag_ui.core import BaseEvent, RunFinishedEvent, RunFinishedInterruptOutcome

# A transfer draft expires 5 minutes after it is prepared (mcp-payments); its interrupt can't outlive it.
PENDING_APPROVAL_TTL_SECONDS = 5 * 60

ConversationKey = tuple[str, str]  # (user id from the token, AG-UI threadId)


@dataclass
class PendingApprovals:
    ttl_seconds: float = PENDING_APPROVAL_TTL_SECONDS
    clock: Callable[[], float] = time.monotonic
    _pending: dict[ConversationKey, dict[str, float]] = field(default_factory=dict)

    def record(self, key: ConversationKey, tool_call_ids: Collection[str]) -> None:
        now = self.clock()
        live = {call: expires for call, expires in self._pending.get(key, {}).items() if expires > now}
        live.update(dict.fromkeys(tool_call_ids, now + self.ttl_seconds))
        self._pending[key] = live

    def consume(self, key: ConversationKey, tool_call_ids: Collection[str]) -> bool:
        """True when every id answers a live interrupt raised for this user and thread. Each is spent either way."""
        pending = self._pending.get(key, {})
        now = self.clock()
        expiries = [pending.pop(call, None) for call in tool_call_ids]
        if not pending:
            self._pending.pop(key, None)
        return bool(expiries) and all(expires is not None and expires > now for expires in expiries)


def _interrupted_calls(event: BaseEvent) -> list[str]:
    outcome = event.outcome if isinstance(event, RunFinishedEvent) else None
    if not isinstance(outcome, RunFinishedInterruptOutcome):
        return []
    return [interrupt.tool_call_id for interrupt in outcome.interrupts if interrupt.tool_call_id]


async def recording_interrupts(
    events: AsyncIterator[BaseEvent], pending: PendingApprovals, key: ConversationKey
) -> AsyncIterator[BaseEvent]:
    """Passes the client-bound events on, remembering the approval interrupts the run ends with."""
    async for event in events:
        if calls := _interrupted_calls(event):
            pending.record(key, calls)
        yield event
