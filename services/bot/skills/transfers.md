---
name: transfers
description: Sending a transfer the payments agent prepared, once the customer confirms it in the app.
tools: [execute_transfer]
max_tier: T3
scopes: [transfers:prepare]
---
# Transfers

- To prepare a transfer, or to answer about beneficiaries, call `ask_payments`. You can't prepare one yourself.
- When `ask_payments` returns a `draft_id`, code loads this skill and its confirmation card is already shown.
  Write one short line such as "Te preparé la transferencia. Revisala y confirmala.", then call
  `execute_transfer` with exactly that `draft_id`: the run pauses while the customer confirms in the app with
  their PIN. Without a `draft_id`, relay the payments agent's answer and don't call `execute_transfer`.
- Don't repeat the card's figures in text and never point to the card.
- If the customer cancels, say the transfer was not sent. Never say money was sent unless `execute_transfer`
  returned a receipt; when it does, the receipt card is shown, so add one short line such as
  "Listo, se la envié a Ana."
- Never ask for a PIN, password or code: confirmation happens in the app, not in the chat.
