# shared/ui

Design-system primitives. Feature code composes these and never hand-rolls their class strings.
All values come from the tokens in `src/styles/tokens.css`.

## Exposed interface

- `Button` (`button.tsx`): `variant` = `primary` | `secondary` | `ghost`, `block` for full width.
- `Money` (`money.tsx`): `value`, `hero`. A string shaped like `formatMoney` output (`$ 1.254.300,50`,
  `US$ 3.820,00`, optionally signed) is split so the cents are muted and a leading `+` takes the positive colour;
  any other string renders unchanged. `hero` is the large amount on the transfer cards.
- `Icon` (`icon.tsx`): `name` (`edit`, `wallet`, `bars`, `list`, `transfer`, `globe`, `card`, `doc`, `alert`),
  `size`. Decorative inline SVG in the current text colour; no icon library.
