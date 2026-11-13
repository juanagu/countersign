import pytest

from app.guardrails.pii import cuit_valid, luhn_valid, pii_check, redact, redact_value, redact_with_kinds
from app.guardrails.verdict import Action


@pytest.mark.parametrize(
    ("text", "kind"),
    [
        ("Mi tarjeta es 4532 0151 1283 0366", "tarjeta"),
        ("tarjeta 4532-0151-1283-0366", "tarjeta"),
        ("CBU 2850590940090418135201", "cbu"),
        ("la cuenta 0170-0002-7810", "cuenta"),
        ("CUIL 20-12345678-6", "cuil"),
        ("mi DNI es 30.123.456", "dni"),
        ("dni: 30123456", "dni"),
        ("escribime a ana.gomez@example.com", "email"),
        ("llamame al +54 9 11 5555-1234", "teléfono"),
        ("o al 11 5555-1234", "teléfono"),
        ("Authorization: Bearer abc.def.ghi", "token"),
        ("eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJhbmEifQ.c2lnbmF0dXJl", "token"),
    ],
)
def test_detects_and_masks_each_kind(text: str, kind: str) -> None:
    redacted, kinds = redact_with_kinds(text)
    assert kinds == [kind]
    assert f"[{kind}]" in redacted


@pytest.mark.parametrize(
    "text",
    [
        "Tu saldo es $ 1.254.300,50",
        "1254300.50 en total, 380000.00 de alquiler",
        "Transferí 500000 a Lucía",
        "El 2026-10-15 a las 10:00",
        "Llamá al 0800-555-0199, las 24 horas",  # The bank's public line is not personal data.
        "4532 0151 1283 0367",  # Fails the Luhn check: not a card number.
        "20-12345678-0",  # Wrong CUIL check digit.
        "30.123.456 pesos",  # A DNI only with its keyword; otherwise it's an amount.
        "acc-ana-ars y ****4521",
    ],
)
def test_leaves_amounts_dates_public_lines_and_invalid_numbers_alone(text: str) -> None:
    assert redact(text) == text


def test_checksums() -> None:
    assert luhn_valid("4532015112830366")
    assert not luhn_valid("4532015112830367")
    assert cuit_valid("20123456786")
    assert not cuit_valid("20123456780")
    assert not cuit_valid("99123456786")  # Not a CUIT prefix.


def test_input_check_redacts_and_names_what_it_found() -> None:
    verdict = pii_check("Mi tarjeta es 4532 0151 1283 0366 y mi mail ana@example.com")
    assert verdict.action is Action.REDACT
    assert verdict.text == "Mi tarjeta es [tarjeta] y mi mail [email]"
    assert verdict.category == "email,tarjeta"


def test_input_check_allows_clean_text() -> None:
    assert pii_check("¿Cuánto tengo en mi cuenta en pesos?").action is Action.ALLOW


def test_redacts_nested_values() -> None:
    value = {"a": ["CBU 2850590940090418135201", 3], "b": ("ana@example.com",), "c": None}
    assert redact_value(value) == {"a": ["CBU [cbu]", 3], "b": ("[email]",), "c": None}
