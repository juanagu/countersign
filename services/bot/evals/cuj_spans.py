"""One `cuj.trial` span per trial, exported to Phoenix (ADR 022). It carries the journey's id, the thread id (the
BFF does not read an inbound `traceparent`, so the thread id is what links the stack's trace to the trial), the
verdict, the turns and the driver. Never content (rule 7)."""

import logging
from collections.abc import Iterable
from dataclasses import dataclass

from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor

from evals.metrics import CUJ_SPAN, DISCARDED_THREADS, SCORE_PREFIX

NANOS = 1_000_000_000
logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class Trial:
    cuj_id: str
    trial: int
    passed: bool
    turns: int
    driver: str
    thread_id: str
    policy_refused: int
    start_ns: int
    end_ns: int
    discarded_threads: tuple[str, ...] = ()
    scores: tuple[tuple[str, float], ...] = ()  # The judge's scores: a number per name, never content.


def emit_trials(trials: Iterable[Trial], endpoint: str | None) -> None:
    """Sends each trial's span; without an endpoint, or when Phoenix is down, the run still reports normally."""
    if not endpoint:
        return
    provider = TracerProvider(resource=Resource.create({"service.name": "countersign-cuj"}))
    provider.add_span_processor(SimpleSpanProcessor(OTLPSpanExporter(endpoint=f"{endpoint.rstrip('/')}/v1/traces")))
    tracer = provider.get_tracer("evals.cuj")
    try:
        for t in trials:
            span = tracer.start_span(CUJ_SPAN, start_time=t.start_ns)
            span.set_attributes(
                {
                    "cuj.id": t.cuj_id,
                    "cuj.trial": t.trial,
                    "cuj.passed": t.passed,
                    "cuj.turns": t.turns,
                    "cuj.driver": t.driver,
                    "cuj.thread_id": t.thread_id,
                    "cuj.policy_refused": t.policy_refused,
                    DISCARDED_THREADS: list(t.discarded_threads),
                    **{f"{SCORE_PREFIX}{name}": value for name, value in t.scores},
                }
            )
            span.end(end_time=t.end_ns)
    except Exception:
        logger.warning("could not export cuj.trial spans", exc_info=True)
    finally:
        provider.shutdown()
