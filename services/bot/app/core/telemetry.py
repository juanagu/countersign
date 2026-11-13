from collections.abc import Callable

from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter
from pydantic_ai import Agent
from pydantic_ai.models.instrumented import InstrumentationSettings

from app.config import Settings

ExporterWrapper = Callable[[SpanExporter], SpanExporter]


def setup_telemetry(app: FastAPI, settings: Settings, wrap_exporter: ExporterWrapper) -> None:
    """Exports spans to Phoenix over OTLP/HTTP. Without an endpoint nothing is exported.

    `wrap_exporter` lets the composition root redact every span before it leaves the process (security rule 7).
    """
    if not settings.otel_exporter_otlp_endpoint:
        return
    provider = TracerProvider(resource=Resource.create({"service.name": settings.otel_service_name}))
    provider.add_span_processor(BatchSpanProcessor(wrap_exporter(OTLPSpanExporter())))
    trace.set_tracer_provider(provider)
    # One span per request, not one per streamed SSE chunk.
    FastAPIInstrumentor.instrument_app(app, excluded_urls="health", exclude_spans=["receive", "send"])
    HTTPXClientInstrumentor().instrument()
    # Prompts, completions and tool data are recorded; the exporter wrapper redacts them before export.
    Agent.instrument_all(InstrumentationSettings(include_content=True))
