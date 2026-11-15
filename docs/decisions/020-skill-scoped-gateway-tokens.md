# 020 — Gateway tokens scoped by the loaded skills, enforced at the gateway

**Status:** proposed, not built (backlog F42). Amends [ADR 017](017-mcp-gateway.md): its "out of scope" line "the
gateway doesn't repeat skill gating" still holds, but the gateway now enforces token scopes. This is a scope check,
not skill gating. Removes ADR 017's "one deliberate widening".

## Context
Least privilege for banking tools currently depends on one layer, the bot's `PolicyToolset`. If that layer has a bug,
or a prompt injection gets past it, nothing else stops the call.

Checked in the code on 2026-11-15:
- **Bot hop.** `TokenExchanger.token_for` (`services/bot/app/banking/token_exchange.py`) sends no `scope`. Client
  `bot` has `inheritSubjectScopes: false` (`apps/bff/src/features/idp/client-policies.ts`), because the `aud=bot`
  token carries only `scope=chat`. So every gateway token gets the whole `mcp-gateway` ceiling: `accounts:read
  beneficiaries:read transfers:prepare transfers:execute`. A run that loaded only `accounts` holds a token that
  could execute a transfer.
- **The IdP already honours `scope`.** `grantedScopes` (`token-exchange.ts`) refuses any requested scope outside the
  allowed set with `invalid_scope` and never trims it. Two gaps: a missing scope *or* a blank one (`scope=`) falls
  back to the whole ceiling, and duplicates are issued as sent.
- **Gateway hop.** The gateway sends no `scope`. Client `mcp-gateway` inherits, so a backend token is
  `ceiling(backend) ∩ gateway token`. Each backend's ceiling equals the scopes its own tools check. A narrow gateway
  token therefore already gives narrow backend tokens. A gateway token with none of a backend's scopes gets
  `invalid_scope`.
- **Gateway calls.** `Catalog.refresh` lists every backend with the caller's token on every `tools/list` and
  keeps a global `lastGood` per backend. `ToolCallProxy` routes by name and never looks at scopes. Tool errors
  are `isError` results with a JSON body (`unknown_tool`, `rate_limited`, …), and the rate limit is checked before
  the breaker (F44).
- **Servers.** Every tool checks exactly one scope with `requireScope` (`@poc/mcp-kit` `tool-result.ts`) and
  declares only `tierMeta(tier)` (`bank/riskTier`, `risk-tier.ts`).
- **Skills.** The `payments` skill lists `list_accounts` and `get_balance`, so it needs `accounts:read` as well. Its
  scope set can't be "payments' scopes". `GATEWAY_NEEDED_BY = {accounts, payments}` is hand-kept in
  `mcp_toolsets.py` (F17).
- **Pydantic AI 2.68.** `MCPToolset(auth=fn)` resolves `auth` once per run in `for_run` and builds one client with
  it. A token can't change inside one `MCPToolset` session.
- **Resume.** The approved `execute_transfer` reaches `SkillGatedMCPToolset.call_tool` with
  `ctx.tool_call_approved = True`, after `PolicyToolset._require_approval`. `payments` is loaded from history
  (`skills/history.py`).
- **The model needs `execute_transfer` in its tool list before approval.** It calls the tool, and that call raises
  the interrupt. So the gateway can't hide the tool from a token without `transfers:execute`.

## Decision

### 1. Each MCP tool declares its scope in `_meta`
`@poc/mcp-kit` replaces `tierMeta` with `toolMeta(tier, scope, { listScope? })` and adds `SCOPE_META_KEY =
'bank/scope'`, `LIST_SCOPE_META_KEY = 'bank/listScope'`, `readScope(meta)` and `readListScope(meta)`. A valid
scope matches `^[a-z]+:[a-z]+$`. `readListScope` returns `listScope ?? scope`. Each tool's handler checks the
same constant it declares.

| Tool | Server | `bank/riskTier` | `bank/scope` (needed to call) | `bank/listScope` (needed to list) |
| --- | --- | --- | --- | --- |
| `list_accounts`, `get_balance`, `list_transactions`, `spending_summary` | mcp-accounts | T1 | `accounts:read` | — |
| `list_beneficiaries` | mcp-payments | T1 | `beneficiaries:read` | — |
| `prepare_transfer` | mcp-payments | T2 | `transfers:prepare` | — |
| `execute_transfer` | mcp-payments | T3 | `transfers:execute` | `transfers:prepare` |

`listScope` exists only for approval-gated tools. Its meaning: whoever may prepare a transfer may see that one can
be executed. Seeing it is not the right to call it. A tool without a valid `bank/scope` is dropped by the gateway
and hidden by the bot, the same way a tool without a tier is handled today.

### 2. Skills declare the scopes they request
Each skill's frontmatter gains an optional `scopes` list (default empty). It holds the **list scopes** of the
skill's MCP tools and never a scope that only an approved call gets:

```yaml
# accounts.md
scopes: [accounts:read]
# payments.md (it also reads accounts)
scopes: [accounts:read, beneficiaries:read, transfers:prepare]
# knowledge.md: no field; search_knowledge is bot-local
```

`Skill.scopes: frozenset[str]` is validated against the same pattern. `SkillRegistry.scopes_by_skill()` returns
`{name: scopes}`, and `main.py` passes it to `banking_toolset`, so `banking` imports nothing from `skills`. A skill
needs the gateway exactly when its `scopes` is non-empty. `GATEWAY_NEEDED_BY` is deleted, which closes the
gateway half of F17.

### 3. The bot exchanges per scope set, and `transfers:execute` only for an approved call
`SkillGatedMCPToolset` exchanges the tokens itself. It opens each `MCPToolset` session on the gateway URL with the
exchanged token as static `auth`. `_exchanged_auth` goes.
- **Wanted set** = the union of `scopes_by_skill[s]` over `ctx.deps.loaded_skills`. If it is empty, there are no
  tools and no exchange (as today).
- **Session.** With no session, or when the wanted set is not a subset of the session's set, the toolset closes the
  current session, exchanges for the wanted set and opens a new one. `loaded_skills` only grows within a run, so a
  run holds one session at a time and exchanges at most once per growth step. Today that is at most twice:
  accounts, then payments.
- **`get_tools`** hides any tool without a valid `bank/scope` and logs its name once.
- **`call_tool`.**
  - If the tool's `bank/scope` is in the session's set, the call goes through the session.
  - If it isn't, `ctx.tool_call_approved` is true and the tool's tier is T3, the toolset exchanges for exactly
    `{bank/scope}` (`transfers:execute`), opens a one-call session, makes the call and closes it. That token is never
    cached or reused.
  - Otherwise the call goes through the session token unchanged, and the gateway refuses it. The toolset does not
    second-guess the policy, and the gateway is the lock.
- **A failed approved exchange** returns the tool error `{"error": "service_unavailable", "service":
  "mcp-gateway"}` without calling the gateway. The step-up `jti` is still unspent, the model says nothing was sent,
  and the customer asks again (ADR 013's failed-resume path). The customer sees what they see today when
  mcp-payments is down at resume.
- **`TokenExchanger.token_for(subject_token, audience, scopes)`** requires a non-empty set, sends it sorted and
  space-joined, and raises `TokenExchangeError` if the response's `scope` isn't exactly that set.

### 4. Token exchange contract
The bot hop always sends `scope`. A pre-approval request, for example:

```
POST /token
Authorization: Basic base64(bot:BOT_CLIENT_SECRET)
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&subject_token=<aud=bot JWT>&subject_token_type=urn:ietf:params:oauth:token-type:access_token
&audience=mcp-gateway&scope=accounts:read beneficiaries:read transfers:prepare
```

```json
200 {"access_token": "…", "issued_token_type": "urn:ietf:params:oauth:token-type:access_token",
     "token_type": "Bearer", "expires_in": 300, "scope": "accounts:read beneficiaries:read transfers:prepare"}
```

The approved call sends `scope=transfers:execute` and gets back a token whose `scope` holds only that. The gateway
hop is unchanged: no `scope` parameter, issued = `ceiling(audience) ∩ subject`.

Rules for every client:
- `scope` is split on spaces and deduplicated. The issued `scope` is that set.
- **Refuse, never trim.** If any requested scope is outside the allowed set (the ceiling, intersected with the
  subject's scopes for clients that inherit), the answer is `400 {"error": "invalid_scope"}`. RFC 6749 lets a server
  issue less than was asked. Trimming would make a bot bug look like a working token until a tool call fails in
  the middle of a conversation. Refusing makes it fail at the exchange, where it is logged.
- A `scope` that is present but blank: `400 {"error": "invalid_request"}`. It never falls back to the ceiling.

New in `ClientPolicy`, set for `bot` only:
- `scopeRequired: true`. A missing `scope` gets `400 {"error": "invalid_request"}`.
- `soloScopes: ['transfers:execute']`. Requesting it together with any other scope gets `400 {"error":
  "invalid_scope"}`. A token that can execute can therefore do nothing else.

The bot-hop formula stays `requested ⊆ ceiling(mcp-gateway)`. The `aud=bot` token carries `chat`, not banking
scopes, so the customer's own consent per scope is not modelled. That is out of scope here.

### 5. The gateway lists and calls by token scope
- **Catalog.** It drops a tool without a valid `bank/scope`. Its calls then answer `unknown_tool`. `Route` gains
  `scope`.
- **`tools/list`** returns the catalog's tools whose `readListScope` is in `principal.scopes`. The filter runs on
  every request, over the shared unfiltered catalog. The F43 catalog cache must cache the unfiltered list and filter
  per request, never cache a filtered one.
- **Refresh.** A backend is skipped for this caller when its last good list has no tool the caller may list. An
  exchange refused with `invalid_scope` also skips the backend. Neither changes its breaker, and its last good list
  stands. To support this, the gateway's `TokenExchangeError` gains `code`, read from the IdP body's `error` only
  when it is one of the RFC 6749 codes.
- **`tools/call` order:** route (`unknown_tool`), then scope, then rate limit, then breaker, then exchange, then
  forward. A call whose route's `bank/scope` is not in `principal.scopes` answers, as a JSON-RPC *result* like
  every other gateway tool error:

  ```json
  {"jsonrpc": "2.0", "id": 7, "result": {"isError": true, "content": [{"type": "text",
   "text": "{\"error\":\"insufficient_scope\",\"scope\":\"transfers:execute\"}"}]}}
  ```

  This refusal never reaches the IdP or the backend and is **not counted** by the rate limiter, as F44 asks for
  every refusal that isn't forwarded. The audit line gets the new outcome `insufficient_scope`, with tool, backend
  and tier.
- Gateway error codes, complete: `unknown_tool`, `insufficient_scope`, `rate_limited`, `service_unavailable`,
  `upstream_error`.

### 6. Caching
- **Bot.** One session per scope set within a run, replaced when the set grows. The approved-call token serves one
  call. Nothing is cached across runs, since each run brings a fresh `aud=bot` token.
- **Gateway.** The backend-token cache stays keyed on `[jti, sub, audience]`. Each bot exchange mints a new `jti`,
  so tokens for different scope sets never share a backend token. A narrow gateway token can't reach a wider
  backend token through the cache. No key change is needed.

### Alternatives weighed
- **Derive skill scopes from `_meta` after `tools/list`** (the brief's other option). Listing needs a token, and
  knowing every tool's scope needs a wide one. That is the widening this ADR removes, or else a catalog-only token
  or endpoint, which is a new surface. Frontmatter follows what skills already do with `max_tier`: the skill declares
  a bound and the tool declares its attribute. A test keeps the two in step (below).
- **A generated tool-to-scope map in `packages/contracts`.** One source for both languages, but it adds a new kind
  of contract (data, not types) for seven tools. The cross-check test gives the same drift protection.
- **Gateway filters `tools/list` by the call scope only.** That hides `execute_transfer` before approval, so the
  model can never raise the interrupt. Hence `listScope`.
- **No list filtering, only call enforcement.** Simpler, but then the model's tool list isn't bounded by the token,
  and a skill or policy bug could widen what the model sees.
- **The gateway sends an explicit `scope` per backend or per tool.** Because each backend's ceiling equals its tools'
  scopes, inheriting already gives the same set (the cross-check pins it). Per-tool scopes would cost one exchange
  per tool scope per `jti` and gain nothing past the gateway's own check.
- **The IdP grants `transfers:execute` only against a presented step-up token.** This would turn "only after
  approval" into an IdP fact, but it repeats `mcp-payments`' checks in a service that doesn't read the payments
  database (ADR 013).
- **One token per tool call.** The narrowest option, and an exchange per call. The skill is already the unit the
  policy reasons in.

### Negative tests (rules 1, 2, 3)
- **IdP** (`apps/bff/test/features/idp/token-exchange.test.ts`, `gateway-exchange.test.ts`):
  - `bot` without `scope` gets `invalid_request`. The existing "every banking scope" tests become this.
  - `scope=` gets `invalid_request`.
  - A scope outside the ceiling (`accounts:write`) gets `invalid_scope` and no token: widening is refused.
  - `transfers:execute` with any other scope gets `invalid_scope`.
  - Duplicates are issued once.
  - The gateway asking a backend whose ceiling the subject doesn't touch gets `invalid_scope`.
- **Gateway, on the real stack** (`services/mcp-gateway/test/features/proxy/scopes.test.ts`, new):
  - An `accounts:read` token lists exactly the four accounts tools. `tools/call prepare_transfer` with it answers
    `insufficient_scope`: the payments backend sees no request, the IdP is never asked for `mcp-payments`, and the
    limiter isn't charged.
  - A pre-approval payments token lists `execute_transfer`. Calling it with a valid step-up token answers
    `insufficient_scope`, and the same step-up token then succeeds on an approved `transfers:execute` token, so the
    `jti` was not spent.
  - For a gateway token `{accounts:read, transfers:prepare}`, the tokens the backends receive decode to exactly
    `{accounts:read}` and `{transfers:prepare}`. A backend token never carries a scope the gateway token lacked.
  - A backend tool without `bank/scope` (via `intercept`) is not listed, and its call answers `unknown_tool`.
  - **Cross-check.** Read `services/bot/skills/*.md` frontmatter (`yaml`, a gateway devDependency). Every
    allow-listed tool the real backends serve must have its list scope in the skill's `scopes`. Every skill scope
    must list at least one of its tools. No skill scope may be a T3 tool's call scope. Each backend's IdP ceiling
    must equal the union of its tools' scopes.
- **Servers** (`account-tools.test.ts`, `transfer-tools.test.ts`): for each listed tool, a principal holding every
  scope except its `bank/scope` gets `insufficient_scope`. **mcp-kit** (`risk-tier.test.ts` or a new `scope.test.ts`):
  `readScope` refuses missing and malformed values.
- **Bot** (`tests/banking/test_token_exchange.py`, `test_mcp_end_to_end.py`, `tests/skills/test_registry.py`):
  - An empty set never reaches the IdP. A response wider than the request is refused.
  - With only accounts loaded, the exchange is exactly `accounts:read`. Loading payments re-exchanges for the
    union.
  - No session token ever holds `transfers:execute`. An approved T3 call uses a separate `transfers:execute`-only
    token. An unapproved T3 call that bypasses the policy goes out with the session token.
  - A failed approved exchange makes no gateway call.
  - A tool without `bank/scope` is hidden.
  - `scopes` is parsed, malformed values are refused, and the default is empty.

### Files and commit order (each commit keeps `make test` and the stack green)
1. `feat(f42): declare each MCP tool's scope in _meta`:
   - `packages/mcp-kit/src/risk-tier.ts` (or a new `tool-meta.ts`), `index.ts`;
   - `services/mcp-accounts/src/features/accounts/account-tools.ts`;
   - `services/mcp-payments/src/features/transfers/transfer-tools.ts`;
   - their tests.
   
   Additive: the gateway copies `_meta` verbatim and the bot ignores unknown keys.
2. `feat(f42): gateway lists and calls by token scope`:
   - `services/mcp-gateway/src/features/proxy/catalog.ts`, `tool-call-proxy.ts`, `audit.ts`, `token-exchanger.ts`;
   - tests.
   
   Today's full-ceiling tokens still see and call everything.
3. `feat(f42): refuse a blank scope and dedupe at the token endpoint`: `apps/bff/src/features/idp/token-exchange.ts`.
   The bot sends no `scope` yet, so nothing it does changes.
4. `feat(f42): request gateway scopes by loaded skill`:
   - `services/bot/skills/accounts.md`, `payments.md`;
   - `app/skills/registry.py`;
   - `app/banking/mcp_toolsets.py` and a new `app/banking/tool_scopes.py` (the two `_meta` keys and readers);
   - `app/banking/token_exchange.py`, `app/main.py`;
   - the bot's MCP fakes, which gain `bank/scope`.
5. `feat(f42): require scope from the bot and keep transfers:execute alone`: `apps/bff/src/features/idp/client-policies.ts`,
   `token-exchange.ts`, and the cross-check test.
6. `docs(f42)`:
   - `docs/architecture.md` §3 (the `scope` parameter), §4 ("connect lazily" becomes scoped), §5 (the approved
     exchange), §12 rows 1–3, §14 (drop F42);
   - ADR 017's status (amended by 020);
   - `backlog.md` F42 done, F17 gateway half;
   - the readmes of `banking`, `skills`, `proxy`, `idp`, `transfers` and `mcp-kit`.

## Consequences
- **Two locks behind the policy.** If `PolicyToolset` lets a tool through that no loaded skill grants, the gateway
  refuses the call. If it skips approval, the gateway refuses `execute_transfer` for lack of `transfers:execute`,
  and `mcp-payments` still requires the step-up token. One thing still rests on bot code: requesting
  `transfers:execute` only for an approved call. The IdP grants it to `bot` whenever it is asked for alone. The money
  lock is still the step-up token.
- **Cost.** One more IdP round trip when a run loads a second banking skill, and one on every approved transfer,
  which is in the money path. If the IdP is down at that moment, the transfer fails without spending the step-up
  `jti`, and the customer asks again. Before, a run that already held a token survived an IdP outage later in the run.
- **Drift.** Frontmatter `scopes` repeats what the tools' `_meta` says. A mismatch hides a tool without any error.
  The cross-check test and the bot's one-time log for hidden tools are the guard. It also checks part of what F18
  asks for.
- **agentgateway.** ADR 017's spike must also confirm that agentgateway can filter `tools/list` and refuse
  `tools/call` by a `_meta` value against JWT scopes (CEL RBAC). Otherwise `listScope` holds it back.
- **Evals and stored conversations.** No change. Tool names stay unprefixed and identical. Tool-selection cases
  see the same tools, because `PolicyToolset` already showed only the loaded skills' tools, and `payments` keeps
  `list_accounts` through `accounts:read`. Stored history holds tool calls and `load_skill` calls, never tokens. A
  conversation paused on an approval before the deploy resumes through the new approved exchange. `make eval`'s
  transfer scenario is the live check of that path.
