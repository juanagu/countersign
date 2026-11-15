"""Streaming output guard: text is released a sentence at a time, after image, PII-leak and grounding checks.

It also withholds what the client must not see: reasoning, the raw render_ui tool call and the delegate calls.
"""

import logging
import re
from collections.abc import Callable, Iterator, Mapping, Sequence
from typing import Any
from uuid import uuid4

from ag_ui.core import (
    ActivitySnapshotEvent,
    BaseEvent,
    EventType,
    RunErrorEvent,
    RunFinishedEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallChunkEvent,
    ToolCallStartEvent,
)

from app.guardrails.figures import bullet_masks
from app.guardrails.grounding import SURFACE_PLUMBING_KEYS, Evidence, ungrounded, ungrounded_in_surface
from app.guardrails.images import strip_images
from app.guardrails.pii import redact, redact_with_kinds
from app.guardrails.verdict import ALLOW, Action, Verdict, block
from app.subagents.registry import DELEGATE_PREFIX

logger = logging.getLogger(__name__)

UNGROUNDED_METRIC = "guardrail.output.ungrounded"
PII_METRIC = "guardrail.output.pii_redacted"
IMAGE_METRIC = "guardrail.output.image_removed"
SURFACE_DROPPED_METRIC = "guardrail.output.surface_dropped"
RUN_ERROR_METRIC = "guardrail.output.run_error"
A2UI_ACTIVITY = "a2ui-surface"  # Model-built; `bank-template` cards are built from tool results in code.
# The model's raw render_ui tree is unvalidated (rule 5): the client gets only the validated `a2ui-surface`.
SERVER_ONLY_TOOLS = frozenset({"render_ui"})
# The model's reasoning is not an answer: it skips the output checks, so it never leaves the bot.
REASONING_EVENTS = frozenset(kind for kind in EventType if kind.name.startswith("REASONING_"))


def is_server_only(tool_name: str) -> bool:
    """`render_ui`, and every delegate tool (`ask_<name>`): its request and reply are model text (ADR 021)."""
    return tool_name in SERVER_ONLY_TOOLS or tool_name.startswith(DELEGATE_PREFIX)


UNGROUNDED_FALLBACK = "(No puedo confirmar ese dato en este momento, así que no lo muestro.)"
SURFACE_FALLBACK = "No pude mostrar ese detalle porque no pude verificar sus cifras."
# An error's text can carry an IdP URL, an HTTP body or model output: the client gets this instead.
RUN_ERROR_MESSAGE = "No pude completar la consulta. Probá de nuevo."
# A sentence ends at terminal punctuation followed by whitespace, or at a line break. A dot inside a number
# ("1.254.300,50") is never followed by whitespace, so amounts split across deltas are not cut.
SENTENCE_END = re.compile(r"[.!?…]+[\"')\]*_]*\s+|\n+")

SentenceCheck = Callable[[str, Evidence], Verdict]


IMAGE_CATEGORY = "image"


def image_check(sentence: str, _: Evidence) -> Verdict:
    stripped = strip_images(sentence)
    return Verdict(Action.REDACT, "image", IMAGE_CATEGORY, stripped) if stripped != sentence else ALLOW


def pii_leak_check(sentence: str, _: Evidence) -> Verdict:
    redacted, kinds = redact_with_kinds(sentence)
    return Verdict(Action.REDACT, "personal data", ",".join(kinds), redacted) if kinds else ALLOW


def grounding_check(sentence: str, evidence: Evidence) -> Verdict:
    missing = ungrounded(sentence, evidence)
    if not missing:
        return ALLOW
    trailing = sentence[len(sentence.rstrip()) :]
    return block(f"{len(missing)} figure(s) not in this run's tool results", text=UNGROUNDED_FALLBACK + trailing)


# Images go first, so an image URL never reaches the other checks or the client.
DEFAULT_CHECKS: tuple[SentenceCheck, ...] = (image_check, pii_leak_check, grounding_check)


def checked_sentence(
    sentence: str, evidence: Evidence, checks: Sequence[SentenceCheck] = DEFAULT_CHECKS
) -> tuple[str, list[Verdict]]:
    """The sentence as the customer gets it, and the verdicts that changed it."""
    sentence = bullet_masks(sentence)
    changes: list[Verdict] = []
    for check in checks:
        verdict = check(sentence, evidence)
        if verdict.action is Action.ALLOW:
            continue
        changes.append(verdict)
        sentence = verdict.text or ""
        if verdict.blocked:
            break
    return sentence, changes


def released_text(text: str, evidence: Evidence) -> str:
    """A whole answer as the guard released it, sentence by sentence; for a reload, so nothing is logged."""
    sentences, rest = split_sentences(text)
    return "".join(checked_sentence(sentence, evidence)[0] for sentence in [*sentences, rest] if sentence)


def _metric(verdict: Verdict) -> str:
    if verdict.blocked:
        return UNGROUNDED_METRIC
    return IMAGE_METRIC if verdict.category == IMAGE_CATEGORY else PII_METRIC


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
        # Model-built cards wait for the end of the next text message (or of the run), so the customer reads the
        # answer first and the card under it, whichever order the model produced them in.
        self._held_surfaces: list[BaseEvent] = []

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
            yield from self._release_surfaces()
        elif isinstance(event, ActivitySnapshotEvent) and event.activity_type == A2UI_ACTIVITY:
            self._held_surfaces.extend(self._surface(event))
        elif isinstance(event, RunErrorEvent):
            yield from self._release_surfaces()
            yield safe_run_error(event)
        elif isinstance(event, RunFinishedEvent):
            yield from self._release_surfaces()
            yield event
        else:
            yield event

    def _release_surfaces(self) -> Iterator[BaseEvent]:
        held, self._held_surfaces = self._held_surfaces, []
        yield from held

    def _withheld(self, event: BaseEvent) -> bool:
        """Reasoning, and every event of a server-only tool call (start, args, end, result)."""
        if event.type in REASONING_EVENTS:
            return True
        if isinstance(event, ToolCallStartEvent | ToolCallChunkEvent) and is_server_only(event.tool_call_name or ""):
            self._withheld_calls.add(str(event.tool_call_id))
        return getattr(event, "tool_call_id", None) in self._withheld_calls

    def check_sentence(self, sentence: str) -> str:
        sentence, changes = checked_sentence(sentence, self._evidence, self._checks)
        for verdict in changes:
            metric = _metric(verdict)
            logger.warning("output sentence changed", extra={"metric": metric, "reason": verdict.reason})
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
        # Masked first, as for a sentence, so a phone number is redacted rather than read as a figure.
        kinds: list[str] = []
        content = redact_surface(event.content, kinds)
        missing = ungrounded_in_surface(content, self._evidence)
        if missing:
            logger.warning("a2ui surface dropped", extra={"metric": SURFACE_DROPPED_METRIC, "figures": len(missing)})
            yield from text_message(SURFACE_FALLBACK)
            return
        if not kinds:
            yield event
            return
        logger.warning("a2ui surface redacted", extra={"metric": PII_METRIC, "reason": ",".join(sorted(set(kinds)))})
        yield event.model_copy(update={"content": content})


def redact_surface(value: Any, kinds: list[str], key: str = "") -> Any:
    """Masks PII in every string a surface shows, like a sentence; ids and references are left intact."""
    if key in SURFACE_PLUMBING_KEYS:
        return value
    if isinstance(value, str):
        redacted, found = redact_with_kinds(value)
        kinds += found
        return redacted
    if isinstance(value, Mapping):
        return {k: redact_surface(child, kinds, str(k)) for k, child in value.items()}
    if isinstance(value, list | tuple):
        return [redact_surface(child, kinds, key) for child in value]
    return value


def safe_run_error(event: RunErrorEvent) -> RunErrorEvent:
    """The original is logged redacted (the logging filter redacts again); the client gets a fixed message."""
    logger.error(
        "agent run failed",
        extra={"metric": RUN_ERROR_METRIC, "error_code": event.code, "error_message": redact(event.message)},
    )
    return RunErrorEvent(type=EventType.RUN_ERROR, message=RUN_ERROR_MESSAGE, code=event.code)


def text_message(text: str) -> Iterator[BaseEvent]:
    """A complete assistant text message written by the server."""
    message_id = str(uuid4())
    yield TextMessageStartEvent(type=EventType.TEXT_MESSAGE_START, message_id=message_id, role="assistant")
    yield TextMessageContentEvent(type=EventType.TEXT_MESSAGE_CONTENT, message_id=message_id, delta=text)
    yield TextMessageEndEvent(type=EventType.TEXT_MESSAGE_END, message_id=message_id)
