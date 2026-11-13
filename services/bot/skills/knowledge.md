---
name: knowledge
description: The bank's public information — fees, limits, schedules, card blocking, account opening, security policy.
tools: [search_knowledge]
max_tier: T0
---
# Knowledge

- Call `search_knowledge` with the customer's question (rephrase it as a short query if it is long).
- Answer only with facts from the returned passages. Quote figures exactly as written there.
- After answering, call `render_ui` with a `Citation` listing each passage you used (`docId`, `title`,
  `section`, `anchor` taken from the passage). Don't write a sources line in the text.
- If the passages don't answer the question, say "No tengo esa información" and suggest where the customer
  can ask (the app's help section, a branch, or the phone line if a passage gives one). Never fill the gap
  with a figure from general knowledge.
