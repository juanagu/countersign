"""What `Guardrails.start_run` gives a run: its calendar and its input gate."""

from datetime import UTC, date, datetime

from app.core.clock import BankClock
from app.guardrails.grounding import ungrounded
from app.guardrails.pipeline import Guardrails
from tests.conftest import allow_input, allow_writes

# 22:00 in Buenos Aires on Nov 13 is already Nov 14 in UTC, where the container runs.
LATE_NOV_13_ART = BankClock(now=lambda: datetime(2026, 11, 14, 1, 0, tzinfo=UTC))


async def test_the_run_guard_uses_the_banks_today_not_the_hosts() -> None:
    guardrails = Guardrails(classifier=allow_input, write_intent=allow_writes, clock=LATE_NOV_13_ART)
    guard = guardrails.start_run(user_id="ana", customer_messages=["¿Qué día es hoy?"], third_party_text_seen=False)

    assert guard.today == date(2026, 11, 13)
    assert ungrounded("Hoy es 13/11.", guard.evidence) == []
    assert ungrounded("Hoy es 14/11.", guard.evidence) != []
