"""The output guard over a stored history: which tool results ground figures, and each answer as it was released."""

from copy import deepcopy

from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse

from app.core.clock import BankClock
from app.guardrails.grounding import Evidence
from app.guardrails.messages import customer_texts, tool_returns_in
from app.guardrails.output_guard import is_server_only, released_text
from app.skills.history import LOAD_SKILL


def grounds_no_figure(tool_name: str) -> bool:
    """Instructions (`load_skill`), UI (`render_ui`) and a subagent's model-written reply (`ask_<name>`) are not bank
    data: like in a run (`PolicyToolset`), they ground no figure. A subagent's own results ground through its
    delegate return's evidence record."""
    return tool_name == LOAD_SKILL or is_server_only(tool_name)


class StoredAnswers:
    """Walks a stored history in order. Each answer is checked against what the output guard grounded it on live:
    the tool results before it, the customer's latest message and the bank's day the answer was given."""

    def __init__(self, clock: BankClock) -> None:
        self._clock = clock
        self._tool_results = Evidence()
        self._latest_prompt = ""

    def read(self, message: ModelMessage) -> None:
        """Takes in a message once it has been shown, so it grounds only the answers after it."""
        if not isinstance(message, ModelRequest):
            return
        for name, content in tool_returns_in([message]):
            if not grounds_no_figure(name):
                self._tool_results.add(content)
        self._latest_prompt = next(reversed(customer_texts([message])), self._latest_prompt)

    def released(self, text: str, answer: ModelResponse) -> str:
        """The text of `answer` as the output guard's deterministic checks (PII, grounding) released it."""
        evidence = deepcopy(self._tool_results)
        evidence.add_date(self._clock.day_of(answer.timestamp))
        evidence.add_text(self._latest_prompt)
        return released_text(text, evidence)
