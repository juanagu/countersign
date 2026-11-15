"""Reads the mock bank's ledger, so the transfer case can prove that money moved exactly once."""

import os
from dataclasses import dataclass
from decimal import Decimal

import psycopg

DEFAULT_DATABASE_URL = "postgres://bank:bank@localhost:5432/bank"
SENT_MEMO = "Transferencia enviada"  # The movement mcp-payments books for each executed transfer.


def database_url() -> str:
    return os.environ.get("TEST_DATABASE_URL") or DEFAULT_DATABASE_URL


@dataclass(frozen=True)
class Ledger:
    """One account's state: its balance, the transfers it sent and the 'sent' movements booked on it."""

    balance: Decimal
    transfers: int
    sent_movements: int

    def minus(self, earlier: "Ledger") -> "Ledger":
        return Ledger(
            self.balance - earlier.balance,
            self.transfers - earlier.transfers,
            self.sent_movements - earlier.sent_movements,
        )


LEDGER_SQL = """
SELECT a.balance,
       (SELECT count(*) FROM bank.transfers t JOIN bank.transfer_drafts d ON d.id = t.draft_id
         WHERE d.source_account_id = a.id),
       (SELECT count(*) FROM bank.transactions x WHERE x.account_id = a.id AND x.memo = %(memo)s)
  FROM bank.accounts a WHERE a.id = %(account)s
"""


async def read_ledger(account_id: str) -> Ledger:
    async with await psycopg.AsyncConnection.connect(database_url()) as conn:
        row = await (await conn.execute(LEDGER_SQL, {"account": account_id, "memo": SENT_MEMO})).fetchone()
    if row is None:
        raise LookupError(f"no account {account_id!r}; run `make seed`")
    return Ledger(Decimal(row[0]), int(row[1]), int(row[2]))


EXPIRE_SQL = """
UPDATE bank.transfer_drafts SET expires_at = now() - interval '1 minute'
 WHERE id = %(draft)s AND status = 'pending'
"""


async def expire_draft(draft_id: str) -> None:
    """Moves a pending draft's expiry into the past. The one write the evals make to the bank besides `make seed`
    (CUJ 08 proves an approval of an expired draft moves nothing)."""
    async with await psycopg.AsyncConnection.connect(database_url()) as conn:
        done = await conn.execute(EXPIRE_SQL, {"draft": draft_id})
    if done.rowcount != 1:
        raise LookupError(f"no pending draft {draft_id!r} to expire")
