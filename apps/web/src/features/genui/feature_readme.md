# genui

Renders what the bot sends besides text.

## Exposed interface

- `bankCatalog` (`catalog.tsx`): the A2UI catalog (`bank-catalog-v1`): Card, Text, KeyValueList, List,
  BarChart, Table, Button, Citation, QuickReplies. Props are derived from
  `@poc/contracts/schemas/a2ui-catalog.json`. There are no input components.
- `bankTemplateRenderer` (`bank-templates.tsx`): the activity renderer for `bank-template`
  (`transfer-confirm`, `transfer-receipt`), validated against `bank-templates.json`.
- `shared/ui/card.css`: the one card style for A2UI `Card` (`.gen-card`) and the transfer templates (`.bank-card`). A Card
  with no title whose only child is a Citation renders as a plain "Fuentes" footer; inside a titled card the
  Citation gets a top rule instead.
- Money-looking strings in lists, key-value rows, bar values, table cells and the transfer templates render
  through `shared/ui` `Money` (cents muted, a leading `+` in the positive colour); other text is unchanged.
- `ChatActionsProvider` / `useChatActions()` (`sendMessage`, `running`): what catalog buttons and quick replies
  (pill `Chip`s, disabled while the agent runs) call.

## Data flow

`ChatScreen` passes `a2ui={{ catalog }}` and `renderActivityMessages` to `CopilotKitProvider`.
`a2ui-surface` activities render through CopilotKit's A2UI renderer with this catalog; `bank-template`
activities render the transactional cards.

The `transfer-confirm` card in the thread (`ConfirmCardInThread`) follows `approval`'s `useConfirmCard`: it carries
the approval footer while pending, the same footer without buttons while the agent runs, and collapses to
`ResolvedLine` once settled. `BankTemplateView` is the card as drawn, with no approval behind it.
