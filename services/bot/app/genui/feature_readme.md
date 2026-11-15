# genui

Generative UI from the bot: model-built A2UI surfaces and code-built server templates.

## Exposed interface

- `genui_toolset()`: the `render_ui` tool (args = the contract's `UiTree`). A valid tree → an
  `ACTIVITY_SNAPSHOT` (`a2ui-surface`) of A2UI v0.9 operations; an invalid one → dropped, logged as
  `a2ui.invalid_payload`, text fallback.
- `TemplateToolset(wrapped)`: attaches a `bank-template` activity (`transfer-confirm` today) to the result
  of the tools that have a template, built from the MCP result, never from model text.
- `CATALOG_ID` (`bank-catalog-v1`), shared with the web catalog.

## Data flow

Domain tool → `TemplateToolset` (card from the result) → `PolicyToolset` (wraps the model-facing value as
untrusted data, keeps the card) → AG-UI stream. `render_ui` → validated → surface event; the output guard withholds the raw `render_ui` call itself.

The output guard grounds the numbers in each `a2ui-surface` against this run's tool results and drops a surface that fails; `bank-template` cards pass untouched.
