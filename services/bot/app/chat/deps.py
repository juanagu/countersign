from dataclasses import dataclass, field


@dataclass
class BotDeps:
    """Per-run context. Identity comes from the verified token, never from the request body or the model."""

    user_id: str
    access_token: str = field(repr=False)
    loaded_skills: set[str] = field(default_factory=set)
