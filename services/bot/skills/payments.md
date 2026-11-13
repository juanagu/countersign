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
- `prepare_transfer` only creates a draft. Tell the customer to review and confirm it in the app. Never
  say money was sent unless `execute_transfer` returned a receipt.
- Never ask for a PIN, password or code: confirmation happens in the app, not in the chat.
