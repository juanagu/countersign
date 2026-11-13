from dataclasses import dataclass, field

from app.guardrails.run_guard import RunGuard
from app.knowledge.chunker import Audience


@dataclass
class BotDeps:
    """Per-run context. Identity comes from the verified token, never from the request body or the model."""

    user_id: str
    access_token: str = field(repr=False)
    loaded_skills: set[str] = field(default_factory=set)
    # Knowledge-base audiences this caller may read.
    audiences: tuple[Audience, ...] = ("public", "customer")
    # The AG-UI threadId: with the user it keys per-conversation limits.
    session_id: str = ""
    # Input verdict gate, tool evidence and write re-evaluation. Unchecked by default: nothing above T0 runs.
    guard: RunGuard = field(default_factory=RunGuard.unchecked)
