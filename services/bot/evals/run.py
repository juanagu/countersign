"""`make eval`: the live golden suite and the red-team set through the BFF, one gate table, `thresholds.yaml`.

Needs `make up`, `make seed` (the transfer case debits Juan's account; `make eval` re-seeds first), `make ingest`
and ANTHROPIC_API_KEY. Exits 1 when any gate is below its threshold.
"""

import argparse
import asyncio
import json
import sys
from dataclasses import asdict, dataclass
from pathlib import Path
from statistics import mean

from pydantic_evals.reporting import EvaluationReport
from rich.console import Console
from rich.table import Table

from app.config import Settings
from evals.golden import build_dataset
from evals.live import LiveInput, LiveOutput, Meta, run_live
from evals.redteam import Result, pass_rate, run_redteam
from evals.thresholds import Thresholds, load_thresholds

CONCURRENCY = 3
Report = EvaluationReport[LiveInput, LiveOutput, Meta]


@dataclass(frozen=True)
class Gate:
    name: str
    measured: float
    required: float
    detail: str

    @property
    def ok(self) -> bool:
        return self.measured >= self.required


def _rate_gate(name: str, passed: int, total: int, required: float) -> Gate:
    return Gate(name, passed / total if total else 0.0, required, f"{passed}/{total} cases")


def golden_gates(report: Report, thresholds: Thresholds) -> list[Gate]:
    gates: list[Gate] = []
    for group in sorted({(case.metadata or {}).get("group", "") for case in report.cases + report.failures}):
        if group not in thresholds.pass_rates:
            continue
        cases = [c for c in report.cases if (c.metadata or {}).get("group") == group]
        errors = [f for f in report.failures if (f.metadata or {}).get("group") == group]
        passed = sum(all(a.value for a in c.assertions.values()) and not c.evaluator_failures for c in cases)
        gates.append(_rate_gate(group, passed, len(cases) + len(errors), thresholds.pass_rates[group]))
    for score, required in thresholds.judge_averages.items():
        values = [float(c.scores[score].value) for c in report.cases if score in c.scores]
        gates.append(Gate(score, mean(values) if values else 0.0, required, f"mean of {len(values)} scores"))
    return gates


def redteam_gates(attacks: list[Result], controls: list[Result], thresholds: Thresholds) -> list[Gate]:
    required = thresholds.pass_rates
    return [
        _rate_gate("redteam", sum(r.passed for r in attacks), len(attacks), required["redteam"]),
        _rate_gate("controls", sum(r.passed for r in controls), len(controls), required["controls"]),
    ]


def print_gates(gates: list[Gate]) -> None:
    table = Table(title="make eval gates (thresholds.yaml)")
    for column in ("gate", "measured", "required", "detail", "result"):
        table.add_column(column)
    for gate in gates:
        status = "[green]PASS[/green]" if gate.ok else "[red]FAIL[/red]"
        table.add_row(gate.name, f"{gate.measured:.2f}", f"{gate.required:.2f}", gate.detail, status)
    Console(width=120).print(table)


def write_summary(path: Path, report: Report, gates: list[Gate]) -> None:
    cases = [
        {
            "name": c.name,
            "group": (c.metadata or {}).get("group"),
            "failed": [name for name, a in c.assertions.items() if not a.value],
            "reasons": {name: a.reason for name, a in c.assertions.items() if not a.value},
            "scores": {name: s.value for name, s in c.scores.items()},
            "seconds": round(c.task_duration, 1),
            "answer": c.output.text[:500],
            "tools": [name for name, _ in c.output.tools],
        }
        for c in report.cases
    ]
    errors = [{"name": f.name, "error": f.error_message} for f in report.failures]
    summary = {"gates": [asdict(g) | {"ok": g.ok} for g in gates], "cases": cases, "errors": errors}
    path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")


async def main(out: Path | None, only: str | None) -> int:
    thresholds = load_thresholds()
    dataset = build_dataset(Settings().guard_model)
    if only:  # A debugging aid: a partial run still applies every gate, so it fails the groups it skipped.
        dataset.cases = [case for case in dataset.cases if only in (case.name or "")]
    report = await dataset.evaluate(run_live, max_concurrency=CONCURRENCY, progress=False)
    report.print(include_reasons=True, include_durations=True)
    attacks, controls = ([], []) if only else await run_redteam(out.with_suffix(".redteam.json") if out else None)
    gates = golden_gates(report, thresholds) + redteam_gates(attacks, controls, thresholds)
    print_gates(gates)
    if out:
        write_summary(out, report, gates)
    print(f"Red-team rate {pass_rate(attacks):.1%}; gates {sum(g.ok for g in gates)}/{len(gates)} passed.")
    return 0 if all(g.ok for g in gates) else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, help="Write the gates and per-case results as JSON here.")
    parser.add_argument("--only", help="Run only the golden cases whose name contains this (skips the red team).")
    args = parser.parse_args()
    sys.exit(asyncio.run(main(args.out, args.only)))
