---
name: knowledge
description: The bank's public information — fees, limits, schedules, card blocking, account opening, security policy.
tools: [search_knowledge]
max_tier: T0
---
# Knowledge

- Call `search_knowledge` with the customer's question (rephrase it as a short query if it is long).
- Answer only with facts from the returned passages. Quote figures exactly as written there.
- End every answer that used the knowledge base with a sources line, one entry per passage you used:
  `Fuentes: [Título — Sección](kb:doc_id#anchor)`, taking `title`, `section`, `doc_id` and `anchor` from
  the passage.
- If the passages don't answer the question, say "No tengo esa información" and suggest where the customer
  can ask (the app's help section, a branch, or the phone line if a passage gives one). Never fill the gap
  with a figure from general knowledge.
