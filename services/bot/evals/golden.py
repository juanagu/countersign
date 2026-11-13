"""The live eval cases: golden cases for Scenarios 1, 2, 3 and 5, KB grounding and tool selection.

Scenario 4 (attacks) is the red-team set in `redteam.yaml`, run alongside these by `evals.run`. Each case's
`metadata["group"]` names the threshold it counts toward (`thresholds.yaml`).
"""

from datetime import date, timedelta

from pydantic_evals import Case, Dataset
from pydantic_evals.evaluators import Evaluator

from app.core.clock import BankClock
from evals.live import LiveInput, LiveOutput, Meta
from evals.live_evaluators import (
    CalledNone,
    CalledTool,
    Cites,
    Contains,
    Grounded,
    HasComponents,
    NoAmounts,
    NoWithheldCalls,
    SpendingMatches,
    loaded_skill,
)
from evals.scenario_evaluators import (
    CITATION_RUBRIC,
    QUALITY_RUBRIC,
    Judge,
    MovedMoneyOnce,
    NoRunErrors,
    ReceiptAfterConfirm,
    ResumedIntact,
)

MONTHS = (
    "enero", "febrero", "marzo", "abril", "mayo", "junio",
    "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
)  # fmt: skip
FEE_DOCS = ("comisiones", "transferencias-internacionales", "preguntas-frecuentes")
LIMIT_DOCS = (
    "limites-de-transferencia", "limites-personalizados", "confirmacion-de-transferencias", "preguntas-frecuentes",
)  # fmt: skip
DATA_TOOLS = ("list_accounts", "get_balance", "list_transactions", "spending_summary", "list_beneficiaries")

LiveCase = Case[LiveInput, LiveOutput, Meta]
LiveEvaluator = Evaluator[LiveInput, LiveOutput, Meta]


def month_range(today: date, months_back: int) -> tuple[date, date]:
    """First and last day of the calendar month `months_back` before today's."""
    first = today.replace(day=1)
    for _ in range(months_back):
        first = (first - timedelta(days=1)).replace(day=1)
    following = (first + timedelta(days=32)).replace(day=1)
    return first, following - timedelta(days=1)


def _case(name: str, group: str, inputs: LiveInput, *evaluators: LiveEvaluator) -> LiveCase:
    return Case(name=name, inputs=inputs, metadata={"group": group}, evaluators=(NoRunErrors(), *evaluators))


def _ask(text: str, user: str = "ana") -> LiveInput:
    return LiveInput.model_validate({"user": user, "turns": [text]})


def _judges(model: str) -> tuple[LiveEvaluator, ...]:
    return Judge("judge_quality", QUALITY_RUBRIC, model), Judge("judge_citation", CITATION_RUBRIC, model)


def _kb_case(name: str, group: str, question: str, judge_model: str, *checks: LiveEvaluator) -> LiveCase:
    knowledge = (loaded_skill("knowledge"), CalledTool("search_knowledge"), NoWithheldCalls())
    return _case(name, group, _ask(question), *knowledge, *checks, *_judges(judge_model))


def scenario_cases(today: date, judge_model: str) -> list[LiveCase]:
    last_from, last_to = month_range(today, 1)
    spending_args = {"from": last_from.isoformat(), "to": last_to.isoformat()}
    transfer = LiveInput(user="juan", turns=["Mandale 50.000 a Ana"], flow="transfer", source_account="acc-juan-ars")
    long_answer = "Explicame en cuatro o cinco oraciones cómo funcionan las transferencias internacionales del banco."
    return [
        _kb_case(
            "scenario-1-kb-answer-with-citation", "scenario", "¿Cuánto cuesta una transferencia internacional?",
            judge_model, Contains("US$ 25"), Contains("0,5"), Cites(FEE_DOCS), Grounded(),
        ),
        _case(
            "scenario-2-spending-chart", "scenario", _ask("¿En qué gasté el mes pasado?"),
            loaded_skill("accounts"), CalledTool("spending_summary", spending_args),
            HasComponents(("BarChart", "List")), SpendingMatches(), NoWithheldCalls(), Grounded(),
        ),
        _case(
            "scenario-3-transfer-with-approval", "scenario", transfer,
            CalledTool("prepare_transfer", {"beneficiary_id": "ben-juan-ana", "amount": 50000, "currency": "ARS"}),
            CalledTool("execute_transfer"), ReceiptAfterConfirm(), MovedMoneyOnce(),
        ),
        _case("scenario-5-resume-after-cut", "scenario", LiveInput(turns=[long_answer], flow="resume"),
              ResumedIntact()),
    ]  # fmt: skip


def kb_cases(judge_model: str) -> list[LiveCase]:
    unknown = (Contains("no tengo esa información"), NoAmounts())
    return [
        _kb_case("kb-daily-limit", "kb_grounding", "¿Cuál es el límite diario para transferir en pesos?",
                 judge_model, Contains("5.000.000"), Cites(LIMIT_DOCS), Grounded()),
        _kb_case("kb-card-block-phone", "kb_grounding", "Perdí mi tarjeta, ¿a qué número llamo para bloquearla?",
                 judge_model, Contains("0800-555-0199"), Cites(("bloqueo-de-tarjetas", "atencion-y-reclamos"))),
        _kb_case("kb-swift-hours", "kb_grounding", "¿En qué horario se procesan las transferencias internacionales?",
                 judge_model, Contains("10"), Contains("15"),
                 Cites(("horarios-de-transferencias", "transferencias-internacionales"))),
        _kb_case("kb-unanswerable-loan-rate", "kb_grounding",
                 "¿Qué tasa de interés tiene el préstamo personal a 24 meses?", judge_model, *unknown),
        _kb_case("kb-unanswerable-crypto-fee", "kb_grounding", "¿Cuánto cobran por comprar bitcoin desde la app?",
                 judge_model, *unknown),
    ]  # fmt: skip


def tool_cases(today: date) -> list[LiveCase]:
    month_from, month_to = month_range(today, 2)
    month = MONTHS[month_from.month - 1]
    transfer_args = {"beneficiary_id": "ben-ana-juan", "source_account_id": "acc-ana-ars", "amount": 10000}
    return [
        _case("tools-usd-balance", "tool_selection", _ask("¿Cuánto tengo en mi caja de ahorro en dólares?"),
              loaded_skill("accounts"), CalledTool("get_balance", {"account_id": "acc-ana-usd"})),
        _case("tools-recent-movements", "tool_selection",
              _ask("Mostrame los últimos movimientos de mi cuenta en pesos."),
              loaded_skill("accounts"), CalledTool("list_transactions", {"account_id": "acc-ana-ars"})),
        _case("tools-spending-named-month", "tool_selection", _ask(f"¿Cuánto gasté por categoría en {month}?"),
              CalledTool("spending_summary", {"from": month_from.isoformat(), "to": month_to.isoformat()})),
        _case("tools-beneficiaries", "tool_selection", _ask("¿A quiénes les puedo transferir?"),
              loaded_skill("payments"), CalledTool("list_beneficiaries")),
        _case("tools-kb-usd-limit", "tool_selection", _ask("¿Cuál es el límite por transferencia en dólares?"),
              loaded_skill("knowledge"), CalledTool("search_knowledge"), CalledNone(DATA_TOOLS)),
        _case("tools-prepare-transfer", "tool_selection", _ask("Mandale 10.000 a Juan"),
              loaded_skill("payments"), CalledTool("prepare_transfer", transfer_args)),
    ]  # fmt: skip


def build_dataset(judge_model: str, today: date | None = None) -> Dataset[LiveInput, LiveOutput, Meta]:
    day = today or BankClock().today()
    cases = [*scenario_cases(day, judge_model), *kb_cases(judge_model), *tool_cases(day)]
    return Dataset[LiveInput, LiveOutput, Meta](name="live-golden", cases=cases)
