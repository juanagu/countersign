"""Evaluators for the live cases: what the customer saw (text, surfaces, cards) and what the bot did (tool calls).

Tool calls are judged from the `TOOL_CALL_*` events the client receives; the raw `render_ui` call is withheld
from the client (rule 5), so surfaces are judged from the validated `a2ui-surface` activities instead.
"""

import json
import re
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from pydantic_evals.evaluators import EvaluationReason, Evaluator, EvaluatorContext

from app.guardrails.figures import number_candidates
from app.guardrails.grounding import Evidence, ungrounded
from app.guardrails.output_guard import UNGROUNDED_FALLBACK
from evals.live import SPENDING_TOOL, LiveInput, LiveOutput, Meta

Ctx = EvaluatorContext[LiveInput, LiveOutput, Meta]
MONEY = re.compile(r"(US\$|\$|ARS|USD)\s?\d")
AMOUNT = re.compile(r"\d[\d.,]*")
WITHHELD_TOOLS = frozenset({"render_ui"})


def reason_for(ok: bool, why: str) -> EvaluationReason:
    return EvaluationReason(value=ok, reason=None if ok else why)


@dataclass
class Contains(Evaluator[LiveInput, LiveOutput, Meta]):
    """The customer read this, in the text or on a surface (the model may put the answer on a card)."""

    needle: str

    def get_default_evaluation_name(self) -> str:
        return f"contains {self.needle!r}"

    def evaluate(self, ctx: Ctx) -> bool:
        return self.needle.lower() in ctx.output.shown.lower()


@dataclass
class NoAmounts(Evaluator[LiveInput, LiveOutput, Meta]):
    """An honest 'I don't know' must not slip in a figure."""

    def evaluate(self, ctx: Ctx) -> bool:
        return MONEY.search(ctx.output.shown) is None


@dataclass
class Grounded(Evaluator[LiveInput, LiveOutput, Meta]):
    """Every figure the customer read is in a tool result, and the output guard never had to replace one."""

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        evidence = Evidence()
        for turn in ctx.inputs.turns:
            evidence.add_text(turn)
        for trace in ctx.output.traces:
            for _, content in trace.tool_results:
                evidence.add_text(content)
        missing = ungrounded(ctx.output.text, evidence)
        replaced = UNGROUNDED_FALLBACK in ctx.output.text
        return reason_for(not missing and not replaced, f"ungrounded {missing}, guard fallback shown: {replaced}")


@dataclass
class Cites(Evaluator[LiveInput, LiveOutput, Meta]):
    """A Citation surface names at least one of these documents."""

    doc_ids: tuple[str, ...]

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        cited = {
            source.get("docId")
            for c in ctx.output.components
            if c.get("component") == "Citation"
            for source in c.get("sources", [])
        }
        return reason_for(bool(cited & set(self.doc_ids)), f"cited {sorted(map(str, cited))}")


@dataclass
class HasComponents(Evaluator[LiveInput, LiveOutput, Meta]):
    names: tuple[str, ...]

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        shown = {c.get("component") for c in ctx.output.components}
        return reason_for(set(self.names) <= shown, f"surface components {sorted(map(str, shown))}")


@dataclass
class NoWithheldCalls(Evaluator[LiveInput, LiveOutput, Meta]):
    """The raw render_ui call never reaches the client."""

    def evaluate(self, ctx: Ctx) -> bool:
        return not {name for name, _ in ctx.output.tools} & WITHHELD_TOOLS


def values_match(expected: Any, actual: Any) -> bool:
    if isinstance(expected, int | float) and isinstance(actual, int | float):
        return Decimal(str(expected)) == Decimal(str(actual))
    return bool(expected == actual)


@dataclass
class CalledTool(Evaluator[LiveInput, LiveOutput, Meta]):
    """Some call to `tool` carried at least these arguments."""

    tool: str
    args: dict[str, Any] = field(default_factory=dict)

    def get_default_evaluation_name(self) -> str:
        return f"called {self.tool}" + (f" {self.args}" if self.args else "")

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        calls = [args for name, args in ctx.output.tools if name == self.tool]
        ok = any(all(values_match(v, args.get(k)) for k, v in self.args.items()) for args in calls)
        return reason_for(ok, f"{self.tool} calls: {calls}; all calls: {[n for n, _ in ctx.output.tools]}")


def loaded_skill(name: str) -> CalledTool:
    return CalledTool("load_skill", {"name": name})


@dataclass
class CalledNone(Evaluator[LiveInput, LiveOutput, Meta]):
    tools: tuple[str, ...]

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        hits = [name for name, _ in ctx.output.tools if name in self.tools]
        return reason_for(not hits, f"called {hits}")


def _amounts(text: str) -> set[Decimal]:
    return {value for token in AMOUNT.findall(text) for value in number_candidates(token)}


def _spending_totals(output: LiveOutput) -> dict[str, list[Decimal]]:
    totals: dict[str, list[Decimal]] = {}
    for content in output.results_of(SPENDING_TOOL):
        for row in json.loads(content).get("untrusted_data", {}).get("categories", []):
            totals.setdefault(row["currency"], []).append(Decimal(row["total"]))
    return totals


def spending_chart_matches(output: LiveOutput) -> EvaluationReason:
    totals = _spending_totals(output)
    charts = [c for c in output.components if c.get("component") == "BarChart"]
    lists = [c for c in output.components if c.get("component") == "List"]
    if not totals or not charts:
        return reason_for(False, f"totals {bool(totals)}, charts {len(charts)}")
    chart = charts[0]
    bars = sorted(Decimal(str(bar["value"])) for bar in chart.get("bars", []))
    expected = sorted(totals.get(chart.get("currency", "ARS"), []))
    return reason_for(bars == expected and not lists, f"bars {bars} vs totals {expected}; lists {len(lists)}")


@dataclass
class SpendingMatches(Evaluator[LiveInput, LiveOutput, Meta]):
    """The BarChart's bars are exactly the totals spending_summary returned, with no List repeating them (F31)."""

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        return spending_chart_matches(ctx.output)


# Phrases that send the customer to a card instead of answering (F28).
CARD_POINTERS = re.compile(r"(?i)\b(arriba|en la tarjeta|te dej[eé] (el )?detalle|en el detalle)\b")


@dataclass
class AnswersInText(Evaluator[LiveInput, LiveOutput, Meta]):
    """The answer is in the assistant's own text, which never points the customer to a card (F28)."""

    def evaluate(self, ctx: Ctx) -> EvaluationReason:
        text = ctx.output.text.strip()
        pointer = CARD_POINTERS.search(text)
        return reason_for(bool(text) and pointer is None, f"text {text[:80]!r}, points to a card: {bool(pointer)}")
