import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { fail, ok, requireScope, toolMeta, type Principal } from '@poc/mcp-kit';
import { z } from 'zod';
import type { Account, AccountsRepository } from './accounts-repository.js';
import { CATEGORY_GUIDANCE, TRANSACTION_CATEGORIES } from './categories.js';

export const READ_SCOPE = 'accounts:read';
export const MAX_TRANSACTIONS = 100;
const DEFAULT_TRANSACTIONS = 20;
const NOT_FOUND = () => fail('account_not_found', 'No encontré esa cuenta entre las tuyas.');

const accountId = z.string().min(1).max(64);
const isoDate = z.iso.date();
// Lower-cased before the enum check so "Supermercado" still finds `supermercado`; the enum stays in the schema.
const category = z.preprocess(
  (value) => (typeof value === 'string' ? value.trim().toLowerCase() : value),
  z.enum(TRANSACTION_CATEGORIES),
);

// Bullets, not asterisks: the model quotes this in markdown, where `**` would open bold.
function maskNumber(number: string): string {
  return `••••${number.slice(-4)}`;
}

function publicAccount({ id, kind, currency, alias, number }: Account) {
  return { id, kind, currency, alias, number: maskNumber(number) };
}

/** Builds the MCP server for one caller; every tool is scoped to `principal.sub`. */
export function buildAccountsServer(principal: Principal, repo: AccountsRepository): McpServer {
  const server = new McpServer({ name: 'mcp-accounts', version: '0.1.0' });
  const denied = () => requireScope(principal.scopes, READ_SCOPE);

  async function ownedAccount(id: string): Promise<Account | undefined> {
    const account = await repo.findAccount(id);
    return account?.customerId === principal.sub ? account : undefined;
  }

  server.registerTool(
    'list_accounts',
    {
      description: "Lists the customer's own accounts (id, type, currency, alias, masked number).",
      annotations: { readOnlyHint: true },
      _meta: toolMeta('T1', READ_SCOPE),
    },
    async () => denied() ?? ok({ accounts: (await repo.listAccounts(principal.sub)).map(publicAccount) }),
  );

  server.registerTool(
    'get_balance',
    {
      description: "Returns the balance of one of the customer's accounts. Use list_accounts first to get its id.",
      inputSchema: { account_id: accountId },
      annotations: { readOnlyHint: true },
      _meta: toolMeta('T1', READ_SCOPE),
    },
    async ({ account_id }) => {
      const scopeError = denied();
      if (scopeError) return scopeError;
      const account = await ownedAccount(account_id);
      if (!account) return NOT_FOUND();
      return ok({ ...publicAccount(account), balance: account.balance });
    },
  );

  server.registerTool(
    'list_transactions',
    {
      description:
        "Lists the customer's transactions, newest first. Amounts are negative for debits. Dates are YYYY-MM-DD, inclusive. " +
        CATEGORY_GUIDANCE,
      inputSchema: {
        account_id: accountId.optional(),
        from: isoDate.optional(),
        to: isoDate.optional(),
        category: category.optional(),
        limit: z.number().int().min(1).max(MAX_TRANSACTIONS).default(DEFAULT_TRANSACTIONS),
      },
      annotations: { readOnlyHint: true },
      _meta: toolMeta('T1', READ_SCOPE),
    },
    async ({ account_id, from, to, category, limit }) => {
      const scopeError = denied();
      if (scopeError) return scopeError;
      if (account_id && !(await ownedAccount(account_id))) return NOT_FOUND();
      const transactions = await repo.listTransactions({
        customerId: principal.sub,
        limit,
        ...(account_id && { accountId: account_id }),
        ...(from && { from }),
        ...(to && { to }),
        ...(category && { category }),
      });
      return ok({ transactions });
    },
  );

  server.registerTool(
    'spending_summary',
    {
      description:
        "Totals the customer's spending (debits) by category and currency for a period. Dates are YYYY-MM-DD, inclusive. " +
        CATEGORY_GUIDANCE,
      inputSchema: { from: isoDate, to: isoDate, account_id: accountId.optional() },
      annotations: { readOnlyHint: true },
      _meta: toolMeta('T1', READ_SCOPE),
    },
    async ({ from, to, account_id }) => {
      const scopeError = denied();
      if (scopeError) return scopeError;
      if (from > to) return fail('invalid_period', 'La fecha de inicio es posterior a la de fin.');
      if (account_id && !(await ownedAccount(account_id))) return NOT_FOUND();
      const categories = await repo.spendingByCategory({
        customerId: principal.sub,
        from,
        to,
        ...(account_id && { accountId: account_id }),
      });
      return ok({ from, to, categories });
    },
  );

  return server;
}
