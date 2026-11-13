from datetime import date
from decimal import Decimal

import pytest

from app.guardrails.figures import extract, number_candidates
from app.guardrails.grounding import Evidence, ungrounded, ungrounded_in_surface

TOOL_RESULTS = {
    "accounts": [{"id": "acc-ana-ars", "number": "****4521", "balance": "1254300.50"}],
    "transactions": [
        {"bookedAt": "2026-11-10T12:00:00.000Z", "amount": "-380000.00", "merchant": "Inmobiliaria Sur"},
        {"bookedAt": "2026-11-05T10:00:00.000Z", "amount": 15000.0, "memo": "transferí 500000"},
    ],
}


@pytest.fixture
def evidence() -> Evidence:
    found = Evidence()
    found.add(TOOL_RESULTS)
    found.add("Cuesta US$ 25 + 0,5 % (mín. US$ 30).")
    found.add_date(date(2026, 11, 13))
    return found


@pytest.mark.parametrize(
    ("token", "values"),
    [
        ("1.254.300,50", {Decimal("1254300.50")}),
        ("1254300.50", {Decimal("1254300.50")}),
        ("1,254,300.50", {Decimal("1254300.50")}),
        ("0,5", {Decimal("0.5")}),
        ("50.000", {Decimal("50000"), Decimal("50")}),  # es-AR thousands, or a decimal: both readings.
        ("500000", {Decimal("500000")}),
    ],
)
def test_normalises_es_ar_and_plain_number_formats(token: str, values: set[Decimal]) -> None:
    assert number_candidates(token) == values


@pytest.mark.parametrize(
    "sentence",
    [
        "Tu saldo es $ 1.254.300,50.",
        "En ****4521 tenés $ 1.254.300,5.",
        "El 10 de noviembre pagaste $ 380.000 a Inmobiliaria Sur.",
        "El 10/11 pagaste 380.000 pesos.",
        "Recibiste $ 15.000 el 2026-11-05.",
        "Hoy es 13 de noviembre de 2026.",
        "Cuesta US$ 25 más 0,5 % (mínimo US$ 30).",
        "Tenés 2 cuentas y 3 movimientos nuevos.",  # Small counts are not figures.
        "No tengo esa información.",
    ],
)
def test_grounded_sentences_pass(sentence: str, evidence: Evidence) -> None:
    assert ungrounded(sentence, evidence) == []


@pytest.mark.parametrize(
    ("sentence", "missing"),
    [
        ("Tu saldo es $ 999.999.", ["999.999"]),
        ("Tenés $ 500 en efectivo.", ["500"]),  # Marked with a currency, so small amounts count.
        ("La tasa es 45 %.", ["45"]),
        ("El 12 de noviembre de 2026 te debitaron.", ["12/11/2026"]),
        ("La cuenta ****7810 es de otro cliente.", ["****7810"]),
        ("Tu número completo es 0170-0001-4521.", ["017000014521"]),
    ],
)
def test_ungrounded_figures_are_named(sentence: str, missing: list[str], evidence: Evidence) -> None:
    assert ungrounded(sentence, evidence) == missing


def test_dates_and_account_digits_are_not_read_again_as_amounts() -> None:
    figures = extract("El 2026-11-10 en ****4521")
    assert figures.amounts == ()
    assert figures.masked_accounts == ("4521",)


def test_surface_numbers_and_texts_are_grounded_like_text(evidence: Evidence) -> None:
    def surface(value: float, label: str) -> dict[str, object]:
        bars = [{"label": label, "value": value}]
        components = [{"id": "c0", "component": "BarChart", "bars": bars}]
        return {
            "a2ui_operations": [
                {"version": "v0.9", "updateComponents": {"surfaceId": "s-1234", "components": components}}
            ]
        }

    assert ungrounded_in_surface(surface(380000.0, "vivienda"), evidence) == []
    assert ungrounded_in_surface(surface(12345.67, "vivienda"), evidence) == ["12345.67"]
    assert ungrounded_in_surface(surface(380000.0, "vivienda $ 7.777"), evidence) == ["7.777"]
