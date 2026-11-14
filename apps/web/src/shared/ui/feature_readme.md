# shared/ui

Design-system primitives. Feature code composes these and never hand-rolls their class strings.
All values come from the tokens in `src/styles/tokens.css`.

## Exposed interface

- `Button` (`button.tsx`): `variant` = `primary` | `secondary` | `ghost`, `block` for full width.
- `Money` (`money.tsx`): `value`, `hero`. A string shaped like `formatMoney` output (`$ 1.254.300,50`,
  `US$ 3.820,00`, optionally signed) is split so the cents are muted and a leading `+` takes the positive colour;
  any other string renders unchanged. `hero` is the large amount on the transfer cards.
- `Chip` (`chip.tsx`): a pill-shaped suggestion or quick reply (a `button`): 40px plus a 2px hit-area extension
  each side, `primary` text, `border-input` border, `primary-soft` on hover, 55% opacity when disabled.
- `card.css`: the card box (`.gen-card`, `.bank-card`) shared by `genui` and `approval`.
- `Icon` (`icon.tsx`): `name` (`edit`, `wallet`, `bars`, `list`, `transfer`, `globe`, `card`, `doc`, `alert`,
  `clock`, `check`, `cross`, `wifiOff`, `spinner`), `size`, `spin` (static under `prefers-reduced-motion`). Decorative inline SVG in the current text colour; no icon library.
