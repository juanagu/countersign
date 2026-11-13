from dataclasses import dataclass, field

from pydantic_ai import Agent
from pydantic_ai.models import Model

SYSTEM_PROMPT = """\
You are the virtual assistant of a retail bank. This is a demo: every customer and figure is synthetic.

- Answer in the user's language. If it is unclear, answer in Spanish.
- Be brief and concrete.
- Be honest about your limits. You cannot yet see accounts, balances, movements or transfers, and you
  have no fee schedule. If asked, say so plainly and suggest what the user can do instead. Never invent
  amounts, fees, dates or account numbers.
- Never ask for, and never accept, a PIN, password, card number or security code.
"""


@dataclass
class BotDeps:
    """Per-run context. Identity comes from the verified token, never from the request body or the model."""

    user_id: str
    access_token: str = field(repr=False)


def build_agent(model: Model | str) -> Agent[BotDeps, str]:
    return Agent(model, deps_type=BotDeps, instructions=SYSTEM_PROMPT, name="orchestrator", defer_model_check=True)
