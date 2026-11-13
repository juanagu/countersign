"""Redacts PII and credentials from log records: the formatted message and every `extra=` field."""

import logging

from app.guardrails.pii import redact, redact_value

# LogRecord attributes that are plumbing, not message content or structured fields.
_RECORD_FIELDS = frozenset(vars(logging.makeLogRecord({})))


class RedactingFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.msg = redact(record.getMessage())
        record.args = None
        for key, value in list(vars(record).items()):
            if key not in _RECORD_FIELDS:
                setattr(record, key, redact_value(value))
        if record.exc_info and not record.exc_text:
            record.exc_text = redact(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        return True
