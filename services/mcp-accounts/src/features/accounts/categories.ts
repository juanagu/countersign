/**
 * The transaction categories in the bank data (`data/seed/002_seed.sql`). The one TS copy: tool schemas and
 * descriptions read it so the model picks a real category instead of guessing one.
 */
export const TRANSACTION_CATEGORIES = [
  'compras',
  'entretenimiento',
  'ingresos',
  'restaurantes',
  'salud',
  'servicios',
  'supermercado',
  'transferencias',
  'transporte',
  'vivienda',
] as const;

export type TransactionCategory = (typeof TRANSACTION_CATEGORIES)[number];

export const CATEGORY_GUIDANCE = `Categories: ${TRANSACTION_CATEGORIES.join(', ')}. Map the customer's words to one of these.`;
