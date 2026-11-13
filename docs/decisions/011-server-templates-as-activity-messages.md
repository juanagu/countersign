# 011 — Server templates travel as AG-UI activity snapshots, not custom events

## Context
The plan asks for the transfer confirm and receipt cards as a custom AG-UI event (`surface`: template id
and version, data, `surfaceId`, nonce). CopilotKit v2 (react-core 1.87) passes `CUSTOM` events only to
agent subscribers (it uses them for interrupts and PredictState); nothing renders them in the message
list, and they are not kept with the thread. Activity messages are rendered inline through
`renderActivityMessages` and stay in the thread's history.

## Decision
The bot emits each template as an `ACTIVITY_SNAPSHOT` with `activityType: "bank-template"`. The content is
the same envelope the plan describes (`template`, `version`, `surfaceId`, `nonce`, `data`), defined in
`packages/contracts/schemas/bank-templates.json`. The event is attached to the tool result by
`TemplateToolset` in code, from the MCP result. The model never supplies template data and cannot call a
tool that does. The web app validates the content against the same schema before rendering it.

## Consequences
The card sits at its place in the conversation and survives a reconnect, like any other message. If
CopilotKit later renders custom events, switching back changes only the event type on both ends.
