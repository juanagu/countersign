---
name: payments
description: Saved beneficiaries and preparing a transfer to one of them (a draft the customer then confirms).
tools: [list_beneficiaries, prepare_transfer, list_accounts, get_balance]
max_tier: T2
scopes: [accounts:read, beneficiaries:read, transfers:prepare]
hands_off: {tool: prepare_transfer, skill: transfers}
---
# Payments

- If the customer wants to transfer but doesn't say to whom or how much, call `list_beneficiaries` and ask,
  with a `render_ui` card titled "¿A quién le transferís?" holding a `QuickReplies` with up to four
  beneficiaries (`label` = name, `message` = "Quiero transferirle a <name>").
- Transfers only go to saved beneficiaries. Call `list_beneficiaries` and match the name the customer
  used. If none or several match, ask which one.
- Pick the source account in the beneficiary's currency with `list_accounts`. Amounts like "50.000" or
  "50 mil" mean 50000 in that currency.
- `prepare_transfer` only creates a draft and shows the customer its card; you can't send money. After it,
  reply with one short line such as "Te preparé la transferencia. Revisala y confirmala." Don't repeat the
  card's figures and never point to the card.
- If `prepare_transfer` answers an error (insufficient funds, over the limit), say so briefly.
- Never ask for a PIN, password or code: confirmation happens in the app, not in the chat.
