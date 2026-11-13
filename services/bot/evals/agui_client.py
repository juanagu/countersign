"""A small AG-UI client that drives the live stack through the BFF, like the browser does."""

import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

BFF_BASE = "http://localhost:5173/api"
RUN_PATH = "/copilotkit/agent/default/run"
CONNECT_PATH = "/copilotkit/agent/default/connect"
STEP_UP_PATH = "/auth/step-up"
RUN_TIMEOUT_SECONDS = 180.0
SSE = {"accept": "text/event-stream"}
A2UI_ACTIVITY = "a2ui-surface"
TEMPLATE_ACTIVITY = "bank-template"

Event = dict[str, Any]
StopWhen = Callable[[list[Event]], bool]


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
    def tool_args(self) -> list[tuple[str, dict[str, Any]]]:
        """(tool name, parsed arguments) for each tool call the client saw, in order."""
        raw = {e["toolCallId"]: "" for e in self.of("TOOL_CALL_START")}
        for event in self.of("TOOL_CALL_ARGS"):
            raw[event["toolCallId"]] = raw.get(event["toolCallId"], "") + event["delta"]
        names = [(e["toolCallId"], e["toolCallName"]) for e in self.of("TOOL_CALL_START")]
        return [(name, _json_object(raw[call_id])) for call_id, name in names]

    @property
    def activities(self) -> list[dict[str, Any]]:
        return self.of("ACTIVITY_SNAPSHOT")

    @property
    def components(self) -> list[dict[str, Any]]:
        """Every component of every A2UI surface the client received."""
        return [
            component
            for activity in self.activities
            if activity.get("activityType") == A2UI_ACTIVITY
            for operation in (activity.get("content") or {}).get("a2ui_operations", [])
            for component in (operation.get("updateComponents") or {}).get("components", [])
        ]

    @property
    def cards(self) -> list[dict[str, Any]]:
        """Server-template cards (confirm, receipt): `{"template": ..., "data": {...}}`."""
        return [a.get("content") or {} for a in self.activities if a.get("activityType") == TEMPLATE_ACTIVITY]

    @property
    def interrupts(self) -> list[dict[str, Any]]:
        return [i for e in self.of("RUN_FINISHED") for i in (e.get("outcome") or {}).get("interrupts") or []]

    @property
    def interrupted(self) -> bool:
        return any((e.get("outcome") or {}).get("type") == "interrupt" for e in self.of("RUN_FINISHED"))

    @property
    def errors(self) -> list[str]:
        return [str(e.get("message")) for e in self.of("RUN_ERROR")]


def _json_object(raw: str) -> dict[str, Any]:
    try:
        parsed = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _sse_events(body: str) -> list[dict[str, Any]]:
    return [json.loads(line[5:]) for line in body.splitlines() if line.startswith("data:")]


def run_body(thread_id: str, messages: list[Event], resume: list[Event] | None = None) -> Event:
    body: Event = {
        "threadId": thread_id,
        "runId": str(uuid.uuid4()),
        "messages": messages,
        "tools": [],
        "context": [],
        "state": {},
        "forwardedProps": {},
    }
    return body | ({"resume": resume} if resume else {})


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

    async def _run(self, resume: list[Event] | None = None) -> RunTrace:
        res = await self.http.post(RUN_PATH, json=run_body(self.thread_id, self.messages, resume), headers=SSE)
        res.raise_for_status()
        events = _sse_events(res.text)
        fold(events, self.messages)
        return RunTrace(events)

    async def say(self, text: str) -> RunTrace:
        self.messages.append({"id": str(uuid.uuid4()), "role": "user", "content": text})
        return await self._run()

    async def resume(self, interrupt: Event, payload: Event) -> RunTrace:
        """Answers an approval interrupt exactly as the browser does (CopilotKit's `useInterrupt` `resolve`).

        CopilotKit first adds a `role: "tool"` message for the paused call, whose content is the resume payload,
        then sends `resume`. Both go out, so the eval catches a bot that rejects what the browser sends.
        """
        self.messages.append(
            {
                "id": str(uuid.uuid4()),
                "role": "tool",
                "toolCallId": interrupt["toolCallId"],
                "content": json.dumps(payload),
            }
        )
        return await self._run([{"interruptId": interrupt["id"], "status": "resolved", "payload": payload}])

    async def step_up(self, card: Event, pin: str) -> str:
        """The PIN dialog: a single-use step-up token bound to the confirm card's draft."""
        data = card["data"]
        grant = {"amount": data["amount"], "currency": data["currency"], "beneficiary_id": data["beneficiaryId"]}
        res = await self.http.post(STEP_UP_PATH, json={"draft_id": data["draftId"], "pin": pin, **grant})
        res.raise_for_status()
        return str(res.json()["step_up_token"])

    async def say_until(self, text: str, stop: StopWhen) -> list[Event]:
        """Starts a run and drops the connection once `stop` holds for the events read so far (a lost network)."""
        self.messages.append({"id": str(uuid.uuid4()), "role": "user", "content": text})
        events: list[Event] = []
        body = run_body(self.thread_id, self.messages)
        async with self.http.stream("POST", RUN_PATH, json=body, headers=SSE) as res:
            res.raise_for_status()
            async for line in res.aiter_lines():
                if line.startswith("data:"):
                    events.append(json.loads(line[5:]))
                    if stop(events):
                        break
        return events

    async def connect(self) -> RunTrace:
        """What a reload does: replays the thread's runs from the BFF's log."""
        res = await self.http.post(CONNECT_PATH, json=run_body(self.thread_id, []), headers=SSE)
        res.raise_for_status()
        return RunTrace(_sse_events(res.text))


def bff_client(base_url: str = BFF_BASE) -> httpx.AsyncClient:
    return httpx.AsyncClient(base_url=base_url, timeout=RUN_TIMEOUT_SECONDS)
