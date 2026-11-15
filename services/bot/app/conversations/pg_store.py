"""Pydantic AI's `ConversationStore` on Postgres: the bot's server-owned conversation history (ADR 015)."""

from collections.abc import Sequence

from psycopg import AsyncConnection
from psycopg_pool import AsyncConnectionPool
from pydantic import TypeAdapter
from pydantic_ai.conversation_store import (
    ConversationConflict,
    ConversationEntry,
    ConversationRecord,
    ConversationStore,
)

_RECORD = TypeAdapter(ConversationRecord)
_ENTRY = TypeAdapter(ConversationEntry)

SCHEMA_DDL = """
CREATE SCHEMA IF NOT EXISTS chat;
CREATE TABLE IF NOT EXISTS chat.conversation_entries (
    id text PRIMARY KEY,
    parent_id text,
    body jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS chat.conversations (
    conversation_id text PRIMARY KEY,
    scope text,
    revision text NOT NULL,
    updated_at timestamptz NOT NULL,
    body jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_scope_updated ON chat.conversations (scope, updated_at DESC);
"""

# Walks the entry chain from the head back to the root in one query.
_HISTORY_SQL = """
WITH RECURSIVE chain(id, parent_id, body, depth) AS (
    SELECT id, parent_id, body, 1 FROM chat.conversation_entries WHERE id = %(head)s
    UNION ALL
    SELECT e.id, e.parent_id, e.body, c.depth + 1
    FROM chat.conversation_entries e JOIN chain c ON e.id = c.parent_id
    WHERE %(limit)s::int IS NULL OR c.depth < %(limit)s::int
)
SELECT body::text FROM chain ORDER BY depth DESC
"""


class PgConversationStore(ConversationStore):
    """Records and entries in the `chat` schema, which `make seed` (the `bank` schema) leaves alone.

    `delete_record` keeps the entries: a concurrent save may be about to point at them.
    """

    def __init__(self, pool: AsyncConnectionPool) -> None:
        self._pool = pool

    async def ensure_schema(self) -> None:
        async with self._pool.connection() as conn:
            await conn.execute(SCHEMA_DDL)

    async def read_record(self, conversation_id: str) -> ConversationRecord | None:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT body::text FROM chat.conversations WHERE conversation_id = %s", (conversation_id,)
            )
            row = await cur.fetchone()
        return _RECORD.validate_json(row[0]) if row else None

    async def read_records(self, *, scope: str | None = None, limit: int | None = None) -> Sequence[ConversationRecord]:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "SELECT body::text FROM chat.conversations WHERE %(scope)s::text IS NULL OR scope = %(scope)s "
                "ORDER BY updated_at DESC LIMIT %(limit)s",
                {"scope": scope, "limit": limit},
            )
            rows = await cur.fetchall()
        return [_RECORD.validate_json(row[0]) for row in rows]

    async def write_record(
        self,
        record: ConversationRecord,
        *,
        new_entries: Sequence[ConversationEntry] = (),
        expected_revision: str | None,
    ) -> None:
        # One transaction: a conflict rolls the new entries back with the record.
        async with self._pool.connection() as conn, conn.transaction():
            for entry in new_entries:
                await conn.execute(
                    "INSERT INTO chat.conversation_entries (id, parent_id, body) VALUES (%s, %s, %s::jsonb) "
                    "ON CONFLICT (id) DO NOTHING",
                    (entry.id, entry.parent_id, _ENTRY.dump_json(entry).decode()),
                )
            if record.head_id is not None and not await _entry_exists(conn, record.head_id):
                raise ConversationConflict(record.conversation_id)
            if not await _write_if_revision(conn, record, expected_revision):
                raise ConversationConflict(record.conversation_id)

    async def delete_record(self, conversation_id: str, *, expected_revision: str) -> None:
        async with self._pool.connection() as conn:
            cur = await conn.execute(
                "DELETE FROM chat.conversations WHERE conversation_id = %s AND revision = %s",
                (conversation_id, expected_revision),
            )
            if cur.rowcount == 0:
                raise ConversationConflict(conversation_id)

    async def read_entry(self, entry_id: str) -> ConversationEntry:
        async with self._pool.connection() as conn:
            cur = await conn.execute("SELECT body::text FROM chat.conversation_entries WHERE id = %s", (entry_id,))
            row = await cur.fetchone()
        if row is None:
            raise LookupError(entry_id)
        return _ENTRY.validate_json(row[0])

    async def read_history(self, head_id: str | None, *, limit: int | None = None) -> list[ConversationEntry]:
        if head_id is None or limit == 0:
            return []
        async with self._pool.connection() as conn:
            cur = await conn.execute(_HISTORY_SQL, {"head": head_id, "limit": limit})
            rows = await cur.fetchall()
        if not rows:
            raise LookupError(head_id)
        return [_ENTRY.validate_json(row[0]) for row in rows]


async def _write_if_revision(conn: AsyncConnection, record: ConversationRecord, expected: str | None) -> bool:
    """Inserts a new record or replaces the one at `expected`; False when the stored revision differs."""
    values = {
        "id": record.conversation_id,
        "scope": record.scope,
        "revision": record.revision,
        "updated_at": record.updated_at,
        "body": _RECORD.dump_json(record).decode(),
        "expected": expected,
    }
    if expected is None:
        sql = (
            "INSERT INTO chat.conversations (conversation_id, scope, revision, updated_at, body) "
            "VALUES (%(id)s, %(scope)s, %(revision)s, %(updated_at)s, %(body)s::jsonb) "
            "ON CONFLICT (conversation_id) DO NOTHING"
        )
    else:
        sql = (
            "UPDATE chat.conversations SET scope = %(scope)s, revision = %(revision)s, "
            "updated_at = %(updated_at)s, body = %(body)s::jsonb "
            "WHERE conversation_id = %(id)s AND revision = %(expected)s"
        )
    cur = await conn.execute(sql, values)
    return cur.rowcount == 1


async def _entry_exists(conn: AsyncConnection, entry_id: str) -> bool:
    cur = await conn.execute("SELECT 1 FROM chat.conversation_entries WHERE id = %s", (entry_id,))
    return await cur.fetchone() is not None
