"""Streaming output guard: text is released a sentence at a time, after grounding and PII-leak checks.

It also withholds what the client must not see: reasoning and the raw render_ui tool call.
"""

import logging
import re
from collections.abc import Callable, Iterator, Sequence
from uuid import uuid4

from ag_ui.core import (
    ActivitySnapshotEvent,
    BaseEvent,
    EventType,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallChunkEvent,
    ToolCallStartEvent,
)

from app.guardrails.grounding import Evidence, ungrounded, ungrounded_in_surface
from app.guardrails.pii import redact_with_kinds
from app.guardrails.verdict import ALLOW, Action, Verdict, block

logger = logging.getLogger(__name__)

UNGROUNDED_METRIC = "guardrail.output.ungrounded"
PII_METRIC = "guardrail.output.pii_redacted"
SURFACE_DROPPED_METRIC = "guardrail.output.surface_dropped"
A2UI_ACTIVITY = "a2ui-surface"  # Model-built; `bank-template` cards are built from tool results in code.
# The model's raw render_ui tree is unvalidated (rule 5): the client gets only the validated `a2ui-surface`.
SERVER_ONLY_TOOLS = frozenset({"render_ui"})
# The model's reasoning is not an answer: it skips the output checks, so it never leaves the bot.
REASONING_EVENTS = frozenset(kind for kind in EventType if kind.name.startswith("REASONING_"))

UNGROUNDED_FALLBACK = "(No puedo confirmar ese dato en este momento, así que no lo muestro.)"
SURFACE_FALLBACK = "No pude mostrar ese detalle porque no pude verificar sus cifras."
# A sentence ends at terminal punctuation followed by whitespace, or at a line break. A dot inside a number
# ("1.254.300,50") is never followed by whitespace, so amounts split across deltas are not cut.
SENTENCE_END = re.compile(r"[.!?…]+[\"')\]*_]*\s+|\n+")

SentenceCheck = Callable[[str, Evidence], Verdict]


def pii_leak_check(sentence: str, _: Evidence) -> Verdict:
    redacted, kinds = redact_with_kinds(sentence)
    return Verdict(Action.REDACT, "personal data", ",".join(kinds), redacted) if kinds else ALLOW


def grounding_check(sentence: str, evidence: Evidence) -> Verdict:
    missing = ungrounded(sentence, evidence)
    if not missing:
        return ALLOW
    trailing = sentence[len(sentence.rstrip()) :]
    return block(f"{len(missing)} figure(s) not in this run's tool results", text=UNGROUNDED_FALLBACK + trailing)


DEFAULT_CHECKS: tuple[SentenceCheck, ...] = (pii_leak_check, grounding_check)


def split_sentences(buffer: str) -> tuple[list[str], str]:
    """Complete sentences (each with its trailing whitespace) and the incomplete rest."""
    sentences: list[str] = []
    start = 0
    for match in SENTENCE_END.finditer(buffer):
        sentences.append(buffer[start : match.end()])
        start = match.end()
    return sentences, buffer[start:]


class OutputGuard:
    """One per run. Transforms AG-UI events; message start and end events are kept paired."""

    def __init__(self, evidence: Evidence, checks: Sequence[SentenceCheck] = DEFAULT_CHECKS) -> None:
        self._evidence = evidence
        self._checks = checks
        self._buffers: dict[str, str] = {}
        self._withheld_calls: set[str] = set()

    def process(self, event: BaseEvent) -> Iterator[BaseEvent]:
        if self._withheld(event):
            return
        if isinstance(event, TextMessageStartEvent):
            self._buffers[event.message_id] = ""
            yield event
        elif isinstance(event, TextMessageContentEvent):
            yield from self._content(event)
        elif isinstance(event, TextMessageEndEvent):
            yield from self._release(event.message_id, self._buffers.pop(event.message_id, ""))
            yield event
        elif isinstance(event, ActivitySnapshotEvent) and event.activity_type == A2UI_ACTIVITY:
            yield from self._surface(event)
        else:
            yield event

    def _withheld(self, event: BaseEvent) -> bool:
        """Reasoning, and every event of a server-only tool call (start, args, end, result)."""
        if event.type in REASONING_EVENTS:
            return True
        if isinstance(event, ToolCallStartEvent | ToolCallChunkEvent) and event.tool_call_name in SERVER_ONLY_TOOLS:
            self._withheld_calls.add(str(event.tool_call_id))
        return getattr(event, "tool_call_id", None) in self._withheld_calls

    def check_sentence(self, sentence: str) -> str:
        for check in self._checks:
            verdict = check(sentence, self._evidence)
            if verdict.action is Action.ALLOW:
                continue
            metric = UNGROUNDED_METRIC if verdict.blocked else PII_METRIC
            logger.warning("output sentence changed", extra={"metric": metric, "reason": verdict.reason})
            sentence = verdict.text or ""
            if verdict.blocked:
                break
        return sentence

    def _content(self, event: TextMessageContentEvent) -> Iterator[BaseEvent]:
        buffer = self._buffers.get(event.message_id, "") + event.delta
        sentences, self._buffers[event.message_id] = split_sentences(buffer)
        yield from self._release(event.message_id, "".join(self.check_sentence(s) for s in sentences), checked=True)

    def _release(self, message_id: str, text: str, *, checked: bool = False) -> Iterator[BaseEvent]:
        text = text if checked else self.check_sentence(text) if text else ""
        if text:
            yield TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=text)

    def _surface(self, event: ActivitySnapshotEvent) -> Iterator[BaseEvent]:
        missing = ungrounded_in_surface(event.content, self._evidence)
        if not missing:
            yield event
            return
        logger.warning("a2ui surface dropped", extra={"metric": SURFACE_DROPPED_METRIC, "figures": len(missing)})
        yield from text_message(SURFACE_FALLBACK)


def text_message(text: str) -> Iterator[BaseEvent]:
    """A complete assistant text message written by the server."""
    message_id = str(uuid4())
    yield TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=message_id, role="assistant")
    yield TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=text)
    yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id)
