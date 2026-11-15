const SYMBOLS: Record<string, string> = { ARS: '$', USD: 'US$' };

/** Formats a decimal string or number as es-AR money, e.g. `$ 1.254.300,50` or `US$ 3.820,00`. */
export function formatMoney(amount: string | number, currency: string): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  const formatted = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    value,
  );
  return `${SYMBOLS[currency] ?? currency} ${formatted}`;
}
