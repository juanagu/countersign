"""Redacts PII and credentials from log records: the formatted message and every `extra=` field."""

import logging

from app.guardrails.pii import redact, redact_value

# LogRecord attributes that are plumbing, not message content or structured fields.
_RECORD_FIELDS = frozenset(vars(logging.makeLogRecord({})))


def _redact_message(record: logging.LogRecord) -> None:
    """Redacts the template and each arg in place: formatters such as uvicorn's unpack `args` by position."""
    if isinstance(record.msg, str):
        record.msg = redact(record.msg)
    if record.args:
        record.args = redact_value(record.args)
    formatted = record.getMessage()
    if redact(formatted) != formatted:  # PII in a non-string arg, or split across the template and an arg.
        record.msg, record.args = redact(formatted), None


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        _redact_message(record)
        for key, value in list(vars(record).items()):
            if key not in _RECORD_FIELDS:
                setattr(record, key, redact_value(value))
        if record.exc_info and not record.exc_text:
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        return True
