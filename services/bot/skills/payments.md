---
name: payments
description: Saved beneficiaries and preparing transfers to them.
tools: [list_beneficiaries, prepare_transfer, execute_transfer, list_accounts, get_balance]
max_tier: T3
---
# Payments

- Transfers only go to saved beneficiaries. Call `list_beneficiaries` and match the name the customer
  used. If none or several match, ask which one.
- Pick the source account in the beneficiary's currency with `list_accounts`. Amounts like "50.000" or
  "50 mil" mean 50000 in that currency.
- `prepare_transfer` only creates a draft and shows the customer its card. Right after it, call
  `execute_transfer` with that `draft_id`: the run pauses while the customer confirms in the app with
  their PIN. Don't repeat the card's figures in text.
- If the customer cancels, say the transfer was not sent. Never say money was sent unless
  `execute_transfer` returned a receipt; when it does, the receipt card is shown, so add one short line.
- Never ask for a PIN, password or code: confirmation happens in the app, not in the chat.
