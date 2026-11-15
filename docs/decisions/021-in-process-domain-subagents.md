# 021 — Domain subagents in the bot's process: delegation as a tool, the orchestrator keeps T3

**Status:** proposed (2026-11-15), not built. The `AGENTS.md` wording in section 8 waits for the user's approval.
Once accepted, it overrides the "multi-agent orchestration" line in `docs/PLAN.md`'s out-of-scope list and the
"One orchestrator agent, no multi-agent" sentence in `AGENTS.md`, the way ADR 017 overrode the gateway line. It
reuses ADR 013 (approval and step-up) and ADR 020 (scopes per loaded skill) without changing either.

## Context
The user has decided on a hybrid. Skills stay the root agent's fast, thin capabilities. **Domain subagents running
in the bot's process** take the complex domains: they are easier to maintain, can run a different model per
domain, and leave room to grow. The user accepts the security trade-off. In-process subagents share one process,
so separate credentials per subagent protect against mistakes, not against a compromised process.

Checked in the code on 2026-11-15:
- **One agent.** `chat/agent.py` builds `orchestrator` with output `[str, DeferredToolRequests]`. Skills grant
  tools to `PolicyToolset` through `BotDeps.loaded_skills`. `SkillGatedMCPToolset` exchanges for the union of
  the loaded skills' `scopes` (ADR 020), and each run gets its own copy and session (`for_run` returns
  `replace(self)`). `build_agent` creates its own `FrequencyCaps`, so a second agent would get a second counter.
- **`RunGuard`** lives in `BotDeps`. It holds the input verdict, the customer's redacted messages,
  `third_party_text_seen` and the grounding evidence.
- **Output guard.** It withholds the events of `SERVER_ONLY_TOOLS` (`render_ui`) and checks every `a2ui-surface`
  activity on the stream, whichever tool attached it.
- **Stored history.** Cards are rebuilt from any `ToolReturnPart.metadata` holding `bank-template` events
  (`conversations/history.py`). History evidence is the `content` of every tool return except
  `NON_EVIDENCE_TOOLS`.
- **Evals** judge tool selection from the `TOOL_CALL_START` events the client receives (`evals/agui_client.py`).
- **The web's approval** reads only the interrupt's `metadata.draft_id` and the confirm card already in the thread
  (`apps/web/src/features/approval/transfer-approval.tsx`).

Checked in pydantic-ai-slim **2.68.0** (`services/bot/uv.lock`), reading the installed source under
`services/bot/.venv/lib/python3.12/site-packages/pydantic_ai/` and its bundled guide
(`.agents/skills/building-pydantic-ai-agents/references/ORCHESTRATION-AND-INTEGRATIONS.md`, "Coordinate Multiple
Agents"):
- **Delegation is a tool that awaits another agent's `run`.** The documented pattern is an `async def` tool that
  calls `await delegate.run(prompt, usage=ctx.usage)`. Sync run methods are refused inside a run. There is no
  agent-as-tool class: `AgentToolset` is only a toolset type alias.
- **`deps` and history are whatever the tool passes.** `run(deps=…)` resolves through `_get_deps` and inherits
  nothing from the calling run. `message_history` is explicit too. Without a `conversation_store` the nested run
  saves nothing, so only the calling tool's return enters the root's stored history.
- **Usage.** `run(usage=…)` mutates the object it is given (`agent/__init__.py`: `usage = usage or RunUsage()`),
  and `UsageLimits` checks `ctx.state.usage` before every request (`_agent_graph.py`). A shared object therefore
  makes any limit tree-wide. Attribution is per span: each agent-run span reports only its own requests
  (`_usage_attribution.py`).
- **Lifetime.** A nested run inherits the caller's deadline (`_cancel.py`, `_current_run_deadline`). Cancelling
  the caller raises `CancelledError` in the tool body, which cancels the awaited run. A subagent that cancels
  itself becomes a failed tool return (`_tool_execution.py`, `cancelled_sub_agent_return`).
- **Events.** The AG-UI stream comes from the root run alone, so a nested run's text, tool calls and returns
  never reach it. A root tool's `ToolReturn.metadata` does: each `BaseEvent` in it is emitted after the
  `TOOL_CALL_RESULT`, and items that aren't events are skipped (`ui/ag_ui/_event_stream.py`, `_handle_tool_result`).
- **Interrupts.** `AGUIEventStream._build_outcome` reads only the root run's output. It builds one `Interrupt` per
  approval in a root `DeferredToolRequests`, with id `INTERRUPT_ID_PREFIX + tool_call_id` and that call's metadata
  (`_interrupt.py`, `approval_to_interrupt`). On resume, `editedArgs` becomes `ToolApproved(override_args)`, which
  replaces that call's arguments and is validated against that tool's schema (`tool_manager.py`).
- **A nested deferral doesn't propagate.** A subagent whose output types include `DeferredToolRequests` ends *its
  own* run with it, and that value comes back to the calling tool while the root runs on. If its output types lack
  `DeferredToolRequests`, a deferred call fails the run with `UserError` ("A deferred tool call was present, but
  `DeferredToolRequests` is not among output types", `_tool_execution.py`). `HandleDeferredToolCalls` and
  `RequestInput` resolve calls inside their own run and never hand them to a parent.

## Decision

### 1. Skill or subagent
A new domain starts as a skill. It becomes a subagent when at least one of the first four rows below says so and
its tools stay within T2. "Room to grow" alone is not a reason: promoting a skill later is a file move, because
the delegate tool is built from the subagent registry.

| | Skill | Subagent |
| --- | --- | --- |
| Model, latency, cost | The orchestrator's model fits | Needs another model or profile: a cheaper one for bulk reads, a stronger one for reasoning |
| Tools | A handful, which fit the root's tool list | More than about eight, or schemas and instructions that would crowd the root's prompt and cache |
| Work | One to three tool calls per answer | Long multi-step work whose intermediate results the root doesn't need |
| Owner | The bot's maintainers | A domain owner who changes instructions, tools and evals without touching the root prompt |
| Tiers | T0 to T3 | T0 to T2 only (section 3) |

**Move up to a separate agent service** when any of these holds:
- the domain must be isolated from the bot process (regulated data, a T3 action of its own, a partner's agent);
- it ships on its own team's release cadence or in another runtime;
- it must scale or fail independently.

That service gets its own process, its own IdP client whose ceiling is its domain's scopes, and its own gateway
audience or actor entry, so the IdP and the gateway enforce its ceiling whatever the bot process does. The bot
calls it over a network protocol (A2A or AG-UI), and the approval interrupt then crosses a process. Both need
their own ADR.

### 2. The mechanism
- **Definition.** A subagent is a markdown file in `services/bot/subagents/`, with the same frontmatter and
  validators as a skill (`name`, `description`, `tools`, `max_tier`, `scopes`) and its instructions as the body.
  Its `max_tier` must be T0, T1 or T2. A subagent name may not match a skill's. `app/subagents/` (new feature)
  parses the files into a `SubagentRegistry` and builds one Pydantic AI `Agent[BotDeps, str]` per subagent, with
  `name` set to the subagent's name. Its toolsets are:
  - `PolicyToolset(TemplateToolset(banking))`, with a `ToolPolicy` over a registry holding only its own skill;
  - `genui_toolset()`.
  
  It has no `load_skill`: its one skill is loaded for the whole run.
- **Model.** One `<NAME>_AGENT_MODEL` and `<NAME>_AGENT_MODEL_FALLBACKS` per subagent (`PAYMENTS_AGENT_MODEL`
  first). Empty means the orchestrator's chain. Each subagent gets its own ADR 018 chain under a role of its name;
  breakers stay keyed by model name and shared. A subagent runs with `agent.run`, which isn't streamed, so it uses
  `request_timeout` like the guard roles and not the first-event deadline.
- **Invocation.** The orchestrator gets one bot-local tool per subagent, `ask_<name>(request: str)`, and an agent
  index in its instructions beside the skill index. The tool:
  1. awaits the run's input verdict, so a blocked message starts no subagent and spends no tokens on one;
  2. builds the subagent's deps with `dataclasses.replace(ctx.deps, loaded_skills={name},
     unavailable_servers=set())`. Identity, the `aud=bot` access token, `session_id` and the **same** `RunGuard`
     carry over; the skills and the unavailable servers don't (section 5 says why the guard is shared);
  3. builds the prompt in code. It holds the orchestrator's `request`, labelled as the orchestrator's, and the
     customer's last three redacted messages (`guard.customer_messages`, the ones the write-intent judge reads).
     There is no `message_history`: each call starts clean and re-reads what it needs, and data from other domains
     stays out of its context;
  4. calls `await subagent.run(prompt, deps=sub_deps, usage=ctx.usage)`;
  5. returns a `ToolReturn` (section 5 gives its shape) and logs one `subagent.run` line.
- **Usage accounting.** `usage=ctx.usage` follows Pydantic AI's delegation pattern, so a `UsageLimits` added later
  bounds the whole turn. Per-agent tokens come from each agent-run span, which `make metrics` already reads.
- **Caps.** One `FrequencyCaps` is built in `main.py` and handed to every agent's `PolicyToolset`. A subagent's T2
  calls therefore count against the conversation's caps, and delegating can't reset them.

### 3. The approval interrupt: the orchestrator keeps T3
**A subagent's deferred call can't pause the root run.** Pydantic AI hands the subagent's `DeferredToolRequests`
back to the delegate tool as a value (Context, "a nested deferral"). `AGUIAdapter` builds interrupts only from the
root's output, and `DeferredToolResults` resumes only the root's history.

**Decision: subagents stop at T2, and the orchestrator owns every T3 tool.** The payments subagent prepares the
draft. The orchestrator calls `execute_transfer` through a thin root skill, `transfers` (`tools: [execute_transfer]`,
`max_tier: T3`, `scopes: [transfers:prepare]`, the list scope ADR 020 gives `execute_transfer`). The interrupt,
`PendingApprovals`, the dropped interrupt answers, the resume, the approved `transfers:execute`-only exchange and the
receipt card all stay on today's code paths.

```mermaid
sequenceDiagram
  autonumber
  participant W as Web (via BFF)
  participant R as Orchestrator
  participant P as Payments subagent (same process)
  participant G as mcp-gateway
  W->>R: "Mandale 50.000 a Ana"
  R->>P: ask_payments(request), plus the customer's last messages
  P->>G: list_beneficiaries, list_accounts, prepare_transfer on its own token
  G-->>P: draft (TemplateToolset builds the confirm card in code)
  P-->>R: reply and draft_id as untrusted data; the card and evidence in the return's metadata
  R-->>W: the confirm card (forwarded by code) and a short line
  R->>R: load transfers, execute_transfer(draft_id): PolicyToolset raises ApprovalRequired
  R-->>W: RUN_FINISHED interrupt (ADR 013, unchanged)
  W->>R: resume with step_up_token
  R->>G: execute_transfer on a transfers:execute-only token (ADR 020)
  G-->>R: receipt, then the receipt card built in code
```

Three locks keep T3 out of a subagent:
- the registry refuses a `max_tier` above T2;
- the skill validator already refuses approval-only scopes;
- a subagent's output type has no `DeferredToolRequests`, so anything that defers inside it fails the run with
  `UserError` instead of pausing quietly.

**One value crosses from a subagent into a T3 call: the `draft_id`.** Code checks it. `execute_transfer`'s
`draft_id` must be one a `prepare_transfer` result recorded in this conversation, in this run's evidence or the
stored history. Otherwise the policy denies the call before any interrupt.

### 4. Credentials
- **One token per agent, never the union.** Each agent has its own `SkillGatedMCPToolset`, built with only its own
  skills' `scopes_by_skill`, and each sees only its own `loaded_skills`. The orchestrator's gateway token holds
  the union of the root skills it loaded. A subagent's token holds its skill's `scopes`: for payments,
  `accounts:read beneficiaries:read transfers:prepare`. Separate exchanges, sessions and `jti`s, and no change to
  `SkillGatedMCPToolset`. A subagent never asks for `transfers:execute`.
- **The in-process weakness, plainly.** Every agent in the process holds the same `aud=bot` token
  (`BotDeps.access_token`) and exchanges it with the same `bot` client secret, so the IdP can't tell which agent
  asked.
  - **What per-agent tokens stop:** a bug in one agent's skill or policy can't reach another agent's tools, because
    its token lacks their scopes and the gateway refuses (ADR 020).
  - **What they don't stop:** any code running in the bot process. A compromised dependency, remote code execution,
    or a bug in the shared exchange or deps code can request any scope in `ceiling(mcp-gateway)`, `transfers:execute`
    alone included, for every customer whose token is in memory. That is no worse than today's single agent, and
    no better.
  - **The money lock doesn't change.** `mcp-payments` executes only against a PIN-backed, single-use step-up token
    bound to the draft (ADR 013).
  - **Real isolation** means a separate agent service with its own process, IdP client and gateway audience
    (section 1).
- **The gateway and the audit can't tell subagents apart, by design.** Nothing new goes into the token:
  - a subagent has no credential of its own, so an `act` entry or an agent claim would be asserted by the same
    `bot` client that asserts everything else. The IdP would be signing a label it can't verify;
  - the gateway and the backends check `act` exactly (`[bot]`, `[mcp-gateway, bot]`, ADR 017). Another link would
    change every verifier and the IdP's chaining, and enforce nothing new;
  - the scope set already differs per agent, and the scope set is what the gateway enforces.
  
  Attribution comes from the trace instead. The `subagent.run` line and the subagent's agent-run span carry the
  trace id, and so does the gateway's `mcp.tool_call` audit line. With a separate service, an actor entry becomes
  real: the service has its own IdP client, so the IdP can put it in `act` and the gateway can require it.

### 5. Guardrails, data and tracing
- **One `RunGuard` across the tree.**
  - The input verdict gates the subagent's tools the same way.
  - `third_party_text_seen` is shared, so a memo the orchestrator read sends the subagent's `prepare_transfer` to
    the write-intent judge. The judge compares the call with the **customer's** messages, not with the
    orchestrator's `request`, which is model text and could carry an injection.
  - The evidence is shared, so the orchestrator's text is grounded against the subagent's real tool results.
- **Per-agent `PolicyToolset`.** Each agent's policy grants only its own skills' tools, within its own tiers,
  argument bounds and the shared caps. The orchestrator can't see `prepare_transfer`, and the subagent can't see
  `execute_transfer`, even where the gateway would list them.
- **The subagent's answer is untrusted data (rule 6).**
  - The orchestrator sees `{"untrusted_data": {"agent", "status", "reply", "draft_id"}, "note": UNTRUSTED_NOTE}`.
  - `reply` is the subagent's text.
  - `draft_id` is copied by code from the last successful `prepare_transfer` result, never from the subagent's
    output.
  - `status` is set by code: `ok`, `unavailable` when the subagent's `unavailable_servers` isn't empty, or
    `failed`, which the orchestrator explains like a tool error.
- **The subagent's text is never grounding evidence.**
  - The domain results the subagent's `PolicyToolset` recorded ride in the return's `metadata` as one evidence
    record. The model never sees it; the history guard reads it in later turns, and never the return's `content`.
  - Without this, figures the subagent wrote would ground the orchestrator's next answer.
- **Cards and surfaces are forwarded by code (rules 4 and 5).**
  - The delegate tool copies two kinds of event from the subagent's `ToolReturnPart.metadata` into its own return's
    `metadata`. They are `bank-template` events, only from template tools (`prepare_transfer`), and `a2ui-surface`
    events, only from `render_ui`, which validated them in the subagent.
  - Nothing is taken from the subagent's output. The stored history then restores the confirm card as it does
    today.
  - Forwarded surfaces pass the output guard like the orchestrator's own (PII masked, ungrounded numbers dropped).
    The payments beneficiary picker therefore looks the same.
- **The delegate call stays inside the bot.** `ask_<name>` joins `SERVER_ONLY_TOOLS`, so the output guard withholds
  its `TOOL_CALL_*` events, as it does `render_ui`'s. The `request` and the `reply` are model text and would
  otherwise reach the client without passing the text guard.
- **Redaction and traces (rule 7).**
  - `Agent.instrument_all(include_content=False)` covers the subagent. Its agent-run span is a child of the
    orchestrator's tool span, and `traceparent` reaches the gateway through httpx, so a turn is still one trace in
    Phoenix.
  - The `subagent.run` line carries the agent, status, duration, the requests made, the tool names in order and
    the trace id. It never carries the request, the reply or any arguments.
  - Customer text was masked before the orchestrator saw it, and the subagent gets the same masked messages.
- **Identity (rule 8).** The subagent's deps derive from the orchestrator's, whose user comes from the verified
  token. Nothing in `request` can change `user_id` or the token.

### 6. Evals: the hook
The client no longer sees a subagent's tool calls (section 5). So `tool_selection` cases for a subagent domain read
two things by trace id from Phoenix, which `make metrics` already queries: the handoff (the `ask_<name>` span) and
the subagent's tool spans. Arguments are judged from the server cards the calls produced. The `scenario` gate
needs no change. It judges the cards the client got and reads "money moved exactly once" from Postgres, so it is
the live check of the whole handoff and of the interrupt. ADR 022 decides how evalbench's critical-user-journey
evals consume this hook.

### 7. First slice: payments
- **Payments (recommended).**
  - It exercises every rule the pattern touches. It needs two tokens in one turn (rule 1), a tier ceiling (2) and
    the T3 handback (3), forwards a card (4) and a surface (5), and treats both the request and the reply as
    untrusted (6).
  - It does so on the flow that `make eval`'s transfer scenario, the Playwright transfer specs and the Postgres
    "money moved once" check already cover end to end.
  - The orchestrator keeps `execute_transfer`, so the code that moves money is unchanged. What moves is `prepare`
    (T2).
  - The cost: one more model request per transfer step.
  - Its own case on section 1's criteria is thin (five tools, the orchestrator's model). It goes first to prove
    the boundary where a mistake costs the most, so the next domain inherits edges that were tested first.
- **Accounts (the alternative).**
  - It is lower risk (T1, no writes) and fits the criteria better: spending analysis is multi-step and could run
    on Haiku.
  - But it proves only the mechanism. The write judge across the boundary, card forwarding and the T3 handback
    would wait for payments, possibly bending conventions accounts had set.
  - Its answers are the busiest UI (charts, tables), so surface forwarding would be tried first where it is
    hardest to read.

**Recommendation: payments.**

### 8. Proposed `AGENTS.md` wording (for the user's approval, not applied)
Under "Architecture", replace "One orchestrator agent, no multi-agent and no A2A in this POC. Domain behaviour
comes from **skills** (markdown instruction files plus a tool allow-list) loaded on demand." with:

> One orchestrator agent, plus **domain subagents** for complex domains (ADR 021). Thin domain behaviour comes
> from **skills** (markdown instruction files plus a tool allow-list) that the orchestrator loads on demand. A
> subagent is a skill that runs as its own Pydantic AI agent in the bot's process, on its own model, called by
> the orchestrator as a tool, with its own tool policy and gateway token. Subagents stop at T2: the orchestrator
> owns every T3 tool. They share one process and one IdP client, so their separate tokens guard against
> mistakes, not against a compromised process. A domain that needs real isolation becomes a separate agent
> service, with its own process, IdP client and gateway audience, under its own ADR. No A2A in this POC.

In the diagram, `├─ orchestrator agent + domain skills` becomes `├─ orchestrator agent + domain skills + in-process
subagents (payments)`. Under **Models**, add `` `PAYMENTS_AGENT_MODEL` (empty = the orchestrator's chain): the
payments subagent. ``

Security rules, changed text in bold:
1. "…exchanges it at the mock IdP (`/token`, RFC 8693-shaped) for `aud=mcp-gateway` **once per agent (the
   orchestrator and each subagent), each token scoped to the skills that agent has loaded, never their union**;
   the gateway lists and serves…" The rest stays as it is.
2. "Tier is declared in tool metadata and enforced by **the tool policy of the agent that calls the tool**, not
   by the prompt. **A subagent's tools stop at T2.**"
3. "`execute_transfer` is approval-required (Pydantic AI deferred tool → AG-UI interrupt) **and held only by the
   orchestrator; a subagent may prepare a transfer, never execute one**." The rest stays as it is.
6. "Wrap tool results so the model sees them as data, and never let text inside a tool result (memos, merchant
   names) trigger a write tool without a fresh policy check. **A subagent's answer reaches the orchestrator as
   untrusted data in the same way, and its text never grounds a figure.**"

Rules 4, 5, 7 and 8 keep their wording. Sections 3 and 5 say how each one holds across the boundary.

### Alternatives weighed
- **Bridge the interrupt through the delegate tool.** The tool would catch the subagent's `DeferredToolRequests`
  and raise `ApprovalRequired` on its own call. On resume it would rerun the subagent with its paused history and
  `DeferredToolResults` for the inner call. It works, but it costs this:
  - The interrupt names `ask_payments`, so `editedArgs` (`draft_id`, `step_up_token`) must validate against
    `ask_payments`' schema, which gains hidden approval-only fields.
  - The paused subagent history exists only in the first request's memory. It needs a second server-side store on
    the money path, keyed by user, thread and call, revision-checked and expiring with the draft. It can't go to
    the client, which is untrusted.
  - The resume makes two model requests after the debit, the subagent's and then the orchestrator's, and either
    can fail once the money has moved.
  - The subagent would hold T3, so its token path would need the approved exchange too.
  
  No domain needs a T3 step in the middle of a subagent's work yet. When one does, it gets its own ADR.
- **Hand the subagent the whole root history.** Simpler prompts, but every other domain's data would land in the
  subagent's context, its tokens would grow with the thread, and its scopes would no longer bound what it reads.
- **A permanent handoff through output functions**, where the orchestrator passes the turn to the subagent and
  doesn't get it back. Pydantic AI supports it, but the turn would lose its one place for the interrupt and for
  answers that span domains.
- **A dedicated list scope for `execute_transfer`**, so the orchestrator's token wouldn't need `transfers:prepare`
  (Consequences). Each backend's IdP ceiling would then hold a scope none of its tools check, breaking ADR 020's
  cross-check. On a cold catalog, the gateway's listing exchange for mcp-payments would also be refused. That is a
  later option if the residual matters.

### Negative tests (rules 1 to 8)
In `services/bot/tests/subagents/` unless named, on `FunctionModel` fakes for both agents:
- **Rule 1.**
  - A turn that delegates to payments and then loads `transfers` makes two exchanges. The subagent's is exactly
    `accounts:read beneficiaries:read transfers:prepare` and the orchestrator's is exactly `transfers:prepare`.
  - With `accounts` also loaded, the orchestrator's token is exactly `accounts:read transfers:prepare`. It never
    gains `beneficiaries:read`, and the subagent's token stays exactly its own.
  - The subagent's session closes when its run ends, and no subagent exchange asks for `transfers:execute`.
  - The gateway's cross-check (`services/mcp-gateway/test/features/proxy/skill-scopes.test.ts`) also reads
    `services/bot/subagents/*.md`, and refuses a subagent scope that is a T3 call scope.
- **Rule 2.**
  - A subagent file with `max_tier: T3`, or a name a skill already uses, fails to load.
  - The subagent's policy hides and denies `execute_transfer` and `list_transactions`, even when the gateway lists
    them.
  - The orchestrator's policy denies `prepare_transfer`, even though its token could call it.
- **Rule 3.**
  - A subagent tool forced to raise `ApprovalRequired` fails the subagent run with `UserError`. Nothing reaches
    the gateway, and the orchestrator gets `status: failed`.
  - End to end through the delegate (extending `tests/policy/test_approval_flow.py`): the interrupt is raised by
    the orchestrator's `execute_transfer`, its `metadata.draft_id` equals the forwarded card's, and the resume
    executes once.
  - `execute_transfer` with a `draft_id` that no `prepare_transfer` recorded is denied before any interrupt.
- **Rule 4.**
  - Only `bank-template` events found on a template tool's return are forwarded.
  - A subagent output or reply holding a template payload produces no card.
  - A forwarded confirm card is restored from stored history.
- **Rule 5.**
  - A forwarded surface with PII is masked, and one with an ungrounded number is dropped.
  - The subagent's raw `render_ui` call never reaches the client, and the `ask_<name>` `TOOL_CALL_*` events are
    withheld.
- **Rule 6.**
  - The orchestrator sees the reply wrapped as `untrusted_data`.
  - A figure found only in the reply is ungrounded in the orchestrator's text, in the same run and from history.
  - After the orchestrator read a memo, the subagent's `prepare_transfer` goes to the write-intent judge with the
    customer's messages, not the `request`, and is denied when the customer didn't ask.
  - A red-team case in `evals/redteam.yaml` drives the same memo injection through the delegation.
- **Rule 7.**
  - With seed names in the `request` and the reply, the `subagent.run` line and the exported spans hold none of
    them.
  - `make pii-scan` passes after the transfer eval.
- **Rule 8.** A `request` naming another customer's id or account changes neither the subagent's `user_id` nor the
  token its exchange presents.
- **Gate and caps.**
  - A blocked message makes no request on the subagent's model.
  - The conversation's sixth T2 call through the subagent is capped.

### Files and commit order (backlog F63; each commit keeps `make test` green)
1. `feat(f63): subagent specs`:
   - `services/bot/app/subagents/registry.py` and `feature_readme.md`;
   - `services/bot/tests/subagents/test_registry.py`.

   It reuses `Skill` and `parse_skill` and adds the T2 ceiling and the name clash check. Nothing loads it yet.
2. `feat(f63): run a subagent behind a delegate tool`:
   - `app/subagents/build.py` and `delegate.py`;
   - `app/chat/agent.py`, which takes `caps` and the delegate toolsets and adds the agent index;
   - `app/guardrails/output_guard.py` (`SERVER_ONLY_TOOLS`), `history_guard.py` and `messages.py` (the
     evidence record);
   - `app/policy/tool_policy.py` (the `draft_id` check);
   - tests.

   Still not wired in `main.py`, so behaviour is unchanged.
3. `feat(f63): payments runs as a subagent`:
   - `services/bot/subagents/payments.md`, built from `skills/payments.md` without `execute_transfer` (`max_tier:
     T2`, same `scopes`, same tools otherwise);
   - `services/bot/skills/transfers.md`, which replaces `payments.md`;
   - `app/main.py` (a banking toolset per agent, one `FrequencyCaps`, the subagent's chain);
   - `app/config.py`, `app/core/llm/model_chain.py`, `.env.example` and `infra/docker-compose.yml`
     (`PAYMENTS_AGENT_MODEL`);
   - the gateway cross-check;
   - `services/bot/evals/golden.py` (payments cases through the hook) and `redteam.yaml`.
4. `docs(f63)`:
   - `docs/architecture.md` §1, 2, 3, 4, 5, 8, 10, 11, 12 and 14;
   - the `PLAN.md` out-of-scope line;
   - the `AGENTS.md` wording as approved;
   - this ADR's status;
   - the backlog row;
   - the readmes of `skills`, `banking`, `policy`, `chat`, `guardrails` and `subagents`.

## Consequences
- **Latency and cost.** A transfer turn adds the subagent's model requests to the orchestrator's. The subagent's
  context is smaller (no other domains, no history), and the orchestrator's grows only by the compact return.
  `make metrics` shows the split per agent span.
- **A stateless subagent.** A follow-up such as "a la cuenta en dólares" reruns its listing tools. The cost is
  tokens, not correctness.
- **A residual on the orchestrator's token.** It holds `transfers:prepare`, the list scope it needs to see
  `execute_transfer`, but its policy grants no prepare tool. A `prepare_transfer` coming from the orchestrator has
  lost the gateway's lock and keeps only the policy's. A draft moves no money and expires in five minutes.
- **Deploy over a paused approval.** A thread paused before the deploy loaded `payments`, which is no longer a root
  skill. Its resume can't see `execute_transfer` and takes ADR 013's failed-resume path: the customer asks again.
- **No T3 inside a subagent.** A domain that needs one in the middle of its work needs the bridged interrupt
  (Alternatives) or a separate service, either under a new ADR.
- **F59** (skills stay loaded for the whole thread) still applies to the orchestrator. A subagent loads its skill
  per call, so its scopes last one call.
- **Payments instructions live in two files**, the subagent's and the `transfers` skill. The cross-check pins their
  scopes, and the golden transfer case pins their behaviour.
- **The isolation limit is accepted, not solved.** Anyone who needs the domains isolated from each other against a
  compromised bot needs separate agent services (section 1).
