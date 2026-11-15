# 012 — The agent generates A2UI and the bot validates it, instead of CopilotKit's injected `generate_a2ui`

## Context
CopilotKit can enable A2UI on the runtime, which injects a `generate_a2ui` tool and middleware that turn
the model's output into surfaces in the BFF. Security rule 5 requires that every A2UI payload is
validated against the catalog schema before it leaves the bot.

## Decision
- The bot offers its own `render_ui` tool. Its argument schema is the contract's `UiTree` (catalog
  components only, nested under one root `Card`); the model fills it, never component ids.
- The tool is built with `Tool.from_schema`, which advertises the schema without validating, so the bot
  validates inside the tool with the generated Pydantic model. An invalid tree is dropped, logged with
  `metric=a2ui.invalid_payload`, and the model is told to answer in text. A schema error therefore never
  becomes a retry loop, nor reaches the client.
- A valid tree becomes A2UI v0.9 operations (`createSurface`, `updateComponents`) in an
  `ACTIVITY_SNAPSHOT` with `activityType: "a2ui-surface"`, the shape CopilotKit's A2UI renderer consumes.
  Values are inline props; no `updateDataModel` binding is needed.
- The runtime's A2UI support stays off. The web app turns the renderer on by passing its catalog
  (`createA2UICatalog`, id `bank-catalog-v1`, basic catalog excluded); its zod props come from the same
  JSON Schema via `z.fromJSONSchema`.

## Consequences
The guardrail sits in the service that owns the model, and the BFF stays a pass-through. The catalog
cannot express inputs, so no login, PIN, password or card-number field can be drawn. Values in a surface
are model-copied from tool results; the Phase 6 grounding check covers them like text.
