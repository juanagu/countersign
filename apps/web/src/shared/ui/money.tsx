import './money.css';

/** Sign, currency symbol, integer part with thousands dots, and `,cc` cents: the shape `formatMoney` produces. */
const MONEY_PATTERN = /^([+−-]?)(US\$|\$) ([\d.]+)(,\d{2})$/;
const INCOMING_SIGN = '+';

export interface MoneyProps {
  /** Text to show; an amount formatted as es-AR money is split, anything else renders unchanged. */
  value: string;
  /** Large amount for the transfer cards. */
  hero?: boolean;
}

export function Money({ value, hero = false }: MoneyProps) {
  const match = MONEY_PATTERN.exec(value);
  const heroClass = hero ? ' money--hero' : '';
  if (!match) return <span className={`money${heroClass}`}>{value}</span>;
  const [, sign, currency, whole, cents] = match;
  const incoming = sign === INCOMING_SIGN ? ' money--in' : '';
  return (
    <span className={`money${heroClass}${incoming}`}>
      {sign}
      <span className="money__cur">{currency}</span> {whole}
      <span className="money__cents">{cents}</span>
    </span>
  );
}
