import json
import logging
from collections.abc import Sequence
from typing import Any

UVICORN_LOGGERS = ("uvicorn", "uvicorn.error", "uvicorn.access")

# LogRecord attributes that are plumbing, not structured fields passed via `extra=`.
_RECORD_FIELDS = set(vars(logging.makeLogRecord({})))

# LOG_LEVEL is shared with the Node services (pino), whose names Python lacks.
_PINO_ALIASES = {"trace": logging.DEBUG, "fatal": logging.CRITICAL}


def resolve_level(name: str) -> int:
    key = name.strip().lower()
    if key in _PINO_ALIASES:
        return _PINO_ALIASES[key]
    level = logging.getLevelNamesMapping().get(key.upper())
    return level if level is not None else logging.INFO


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {
            "level": record.levelname.lower(),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        entry.update({k: v for k, v in vars(record).items() if k not in _RECORD_FIELDS})
        if record.exc_text:
            entry["exc"] = record.exc_text
        elif record.exc_info:
            entry["exc"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def configure_logging(level: str, filters: Sequence[logging.Filter] = ()) -> None:
    """JSON lines on stderr. `filters` run on every record first: the composition root passes PII redaction."""
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    for log_filter in filters:
        handler.addFilter(log_filter)
    logging.basicConfig(level=resolve_level(level), handlers=[handler], force=True)
    for name in UVICORN_LOGGERS:
        for uvicorn_handler in logging.getLogger(name).handlers:
            for log_filter in filters:
                uvicorn_handler.addFilter(log_filter)
