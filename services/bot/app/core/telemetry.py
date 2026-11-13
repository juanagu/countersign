from fastapi import FastAPI
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from pydantic_ai import Agent
from pydantic_ai.models.instrumented import InstrumentationSettings

from app.config import Settings


def setup_telemetry(app: FastAPI, settings: Settings) -> None:
    """Exports spans to Phoenix over OTLP/HTTP. Without an endpoint nothing is exported."""
    if not settings.otel_exporter_otlp_endpoint:
        return
    provider = TracerProvider(resource=Resource.create({"service.name": settings.otel_service_name}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))
    trace.set_tracer_provider(provider)
    # One span per request, not one per streamed SSE chunk.
    FastAPIInstrumentor.instrument_app(app, excluded_urls="health", exclude_spans=["receive", "send"])
    HTTPXClientInstrumentor().instrument()
    # Prompts and completions stay out of spans until the Phase 6 redaction lands (security rule 7).
    Agent.instrument_all(InstrumentationSettings(include_content=False))
