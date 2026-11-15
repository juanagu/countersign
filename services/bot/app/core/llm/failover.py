"""Which model failures move a request to the next model, and the `llm.failover` record each one leaves.

The reason comes from the exception class, never its message: a provider error can quote the prompt (rule 7).
"""

import logging
from collections.abc import Callable, Sequence

from pydantic_ai.exceptions import (
    ModelAPIError,
    ModelConnectionError,
    ModelHTTPError,
    ModelOverloadedError,
    ModelQuotaExceededError,
    ModelRateLimitError,
    ModelRequestRejectedError,
    ModelRequestTimeout,
    ModelServerError,
    ModelUnavailableError,
)

from app.core.llm.circuit_breaker import BreakerRegistry, CircuitOpenError
from app.core.llm.run_record import current_run_record

logger = logging.getLogger(__name__)

FAILOVER_METRIC = "llm.failover"
SERVER_ERROR_STATUS = 500

# Most specific first: an overload is also "unavailable", a transport timeout also a connection error.
_REASONS: tuple[tuple[type[ModelAPIError], str], ...] = (
    (ModelRateLimitError, "rate_limited"),
    (ModelOverloadedError, "overloaded"),
    (ModelUnavailableError, "unavailable"),
    (ModelServerError, "server_error"),
    (ModelConnectionError, "connection"),
)
# An HTTP error the adapter left uncategorized, by status.
_STATUS_REASONS = {429: "rate_limited", 529: "overloaded", 503: "unavailable"}
# Configuration errors: failover would hide them, and a second model on the account fails the same way.
_NEVER = (ModelQuotaExceededError, ModelRequestRejectedError)


def failover_reason(error: BaseException) -> str | None:
    """The reason class this failure fails over for, or None when it must surface."""
    if isinstance(error, CircuitOpenError):
        return "circuit_open"
    if isinstance(error, ModelRequestTimeout):
        return "first_event_timeout" if error.setting == "first_event_timeout" else "request_timeout"
    if not isinstance(error, ModelAPIError) or isinstance(error, _NEVER):
        return None
    for error_class, reason in _REASONS:
        if isinstance(error, error_class):
            return reason
    if isinstance(error, ModelHTTPError):
        status = error.status_code
        return _STATUS_REASONS.get(status, "server_error" if status >= SERVER_ERROR_STATUS else None)
    return None


def failover_handler(role: str, model_names: Sequence[str], breakers: BreakerRegistry) -> Callable[[Exception], bool]:
    """The chain's `fallback_on`: classifies a failure, records it with the breaker and the run, and logs it."""

    def falls_back(error: Exception) -> bool:
        reason = failover_reason(error)
        if reason is None:
            return False
        model_name = error.model_name if isinstance(error, ModelAPIError) else "unknown"
        if reason != "circuit_open":
            breakers.for_model(model_name).record_failure()
        if (record := current_run_record()) is not None:
            record.record_failover(model_name)
        position = model_names.index(model_name) if model_name in model_names else None
        next_model = model_names[position + 1] if position is not None and position + 1 < len(model_names) else None
        fields = {
            "metric": FAILOVER_METRIC,
            "role": role,
            "from_model": model_name,
            "to_model": next_model,
            "reason": reason,
            "attempt": None if position is None else position + 1,
        }
        logger.warning("model failed over", extra=fields)
        return True

    return falls_back
