"""A small AG-UI client that drives the live stack through the BFF, like the browser does."""

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx

BFF_BASE = "http://localhost:5173/api"
RUN_PATH = "/copilotkit/agent/default/run"
RUN_TIMEOUT_SECONDS = 180.0


@dataclass
class RunTrace:
    """What one run sent to the client."""

    events: list[dict[str, Any]]

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [e for e in self.events if e.get("type") == kind]

    @property
    def text(self) -> str:
        return "".join(e["delta"] for e in self.of("TEXT_MESSAGE_CONTENT"))

    @property
    def tool_calls(self) -> list[str]:
        return [e["toolCallName"] for e in self.of("TOOL_CALL_START")]

    @property
    def tool_results(self) -> list[tuple[str, str]]:
        """(tool name, result content) for each tool result in the run."""
        names = {e["toolCallId"]: e["toolCallName"] for e in self.of("TOOL_CALL_START")}
        return [(names.get(e["toolCallId"], ""), str(e.get("content", ""))) for e in self.of("TOOL_CALL_RESULT")]

    @property
    def activities(self) -> list[dict[str, Any]]:
        return self.of("ACTIVITY_SNAPSHOT")

    @property
    def interrupted(self) -> bool:
        return any((e.get("outcome") or {}).get("type") == "interrupt" for e in self.of("RUN_FINISHED"))

    @property
    def errors(self) -> list[str]:
        return [str(e.get("message")) for e in self.of("RUN_ERROR")]


def _sse_events(body: str) -> list[dict[str, Any]]:
    return [json.loads(line[5:]) for line in body.splitlines() if line.startswith("data:")]


def fold(events: list[dict[str, Any]], messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Appends the run's assistant, tool and activity messages to the history, as CopilotKit does."""
    by_id: dict[str, dict[str, Any]] = {}
    for event in events:
        kind = event["type"]
        if kind == "TEXT_MESSAGE_START":
            message = {"id": event["messageId"], "role": "assistant", "content": ""}
            messages.append(message)
            by_id[message["id"]] = message
        elif kind == "TEXT_MESSAGE_CONTENT":
            by_id[event["messageId"]]["content"] += event["delta"]
        elif kind == "TOOL_CALL_START":
            parent = event.get("parentMessageId") or str(uuid.uuid4())
            if parent not in by_id:
                by_id[parent] = {"id": parent, "role": "assistant", "content": ""}
                messages.append(by_id[parent])
            call = {
                "id": event["toolCallId"],
                "type": "function",
                "function": {"name": event["toolCallName"], "arguments": ""},
            }
            by_id[parent].setdefault("toolCalls", []).append(call)
            by_id[event["toolCallId"]] = call
        elif kind == "TOOL_CALL_ARGS":
            by_id[event["toolCallId"]]["function"]["arguments"] += event["delta"]
        elif kind == "TOOL_CALL_RESULT":
            messages.append(
                {
                    "id": event["messageId"],
                    "role": "tool",
                    "toolCallId": event["toolCallId"],
                    "content": event["content"],
                }
            )
    return messages


@dataclass
class BffSession:
    """A signed-in browser session: the BFF's HttpOnly cookie is kept by the client."""

    http: httpx.AsyncClient
    thread_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    messages: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    async def login(cls, http: httpx.AsyncClient, username: str) -> "BffSession":
        res = await http.post("/auth/login", json={"username": username})
        res.raise_for_status()
        return cls(http)

    async def say(self, text: str) -> RunTrace:
        self.messages.append({"id": str(uuid.uuid4()), "role": "user", "content": text})
        body = {
            "threadId": self.thread_id,
            "runId": str(uuid.uuid4()),
            "messages": self.messages,
            "tools": [],
            "context": [],
            "state": {},
            "forwardedProps": {},
        }
        res = await self.http.post(RUN_PATH, json=body, headers={"accept": "text/event-stream"})
        res.raise_for_status()
        events = _sse_events(res.text)
        fold(events, self.messages)
        return RunTrace(events)


def bff_client(base_url: str = BFF_BASE) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=base_url, timeout=RUN_TIMEOUT_SECONDS)
