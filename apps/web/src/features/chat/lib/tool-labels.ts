const CONSULTING_ACCOUNTS = 'Consultando tus cuentas…';
const PREPARING_TRANSFER = 'Preparando la transferencia…';

/**
 * What the customer reads while the bot runs a tool. A fixed map: never the tool's arguments or result, and
 * tools that are not listed (`load_skill`, `render_ui`, anything new) show nothing.
 */
const LABELS: Readonly<Record<string, string>> = {
  list_accounts: CONSULTING_ACCOUNTS,
  get_balance: CONSULTING_ACCOUNTS,
  list_transactions: 'Consultando tus movimientos…',
  spending_summary: 'Sumando tus gastos…',
  search_knowledge: 'Buscando en la información del banco…',
  // One line for the whole payments delegation: the bot sends a single status call around the subagent's run.
  ask_payments: PREPARING_TRANSFER,
};

export function toolStatusLabel(toolName: string): string | undefined {
  return Object.hasOwn(LABELS, toolName) ? LABELS[toolName] : undefined;
}
