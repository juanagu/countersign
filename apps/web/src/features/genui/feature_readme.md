# genui

Renders what the bot sends besides text.

## Exposed interface

- `bankCatalog` (`catalog.tsx`): the A2UI catalog (`bank-catalog-v1`): Card, Text, KeyValueList, List,
  BarChart, Table, Button, Citation, QuickReplies. Props are derived from
  `@poc/contracts/schemas/a2ui-catalog.json`. There are no input components.
- `bankTemplateRenderer` (`bank-templates.tsx`): the activity renderer for `bank-template`
  (`transfer-confirm`, `transfer-receipt`), validated against `bank-templates.json`.
- `ChatActionsProvider` / `useChatActions().sendMessage`: what catalog buttons and quick replies call.

## Data flow

`ChatScreen` passes `a2ui={{ catalog }}` and `renderActivityMessages` to `CopilotKitProvider`.
`a2ui-surface` activities render through CopilotKit's A2UI renderer with this catalog; `bank-template`
activities render the transactional cards.
