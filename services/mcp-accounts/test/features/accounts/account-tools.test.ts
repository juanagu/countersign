import { createJwtVerifier } from '@poc/mcp-kit';
import { createTestKeys, TEST_ISSUER, type TestKeys } from '@poc/mcp-kit/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { AUDIENCE, createApp } from '../../../src/app.js';
import { TRANSACTION_CATEGORIES } from '../../../src/features/accounts/categories.js';
import { InMemoryAccountsRepository } from '../../support/in-memory-accounts.js';
import { connectClient, parseText } from '../../support/mcp-client.js';

let keys: TestKeys;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  keys = await createTestKeys();
  const verify = createJwtVerifier({
    issuer: TEST_ISSUER,
    audience: AUDIENCE,
    allowedActors: ['bot'],
    keys: keys.keys,
  });
  app = createApp({ verify, accounts: new InMemoryAccountsRepository() });
});

const anaToken = () => keys.sign({ aud: AUDIENCE, sub: 'ana', scope: 'accounts:read' });

describe('mcp-accounts tools', () => {
  it('declares a risk tier on every tool', async () => {
    const client = await connectClient(app, await anaToken());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_balance',
      'list_accounts',
      'list_transactions',
      'spending_summary',
    ]);
    for (const tool of tools) expect(tool._meta?.['bank/riskTier']).toBe('T1');
  });

  it("lists only the caller's accounts, with masked numbers", async () => {
    const client = await connectClient(app, await anaToken());
    const body = parseText(await client.callTool({ name: 'list_accounts', arguments: {} }));
    expect(body.accounts).toEqual([
      { id: 'acc-ana-ars', kind: 'savings', currency: 'ARS', alias: 'Pesos', number: '••••4521' },
    ]);
  });

  it('returns the balance of an own account', async () => {
    const client = await connectClient(app, await anaToken());
    const body = parseText(await client.callTool({ name: 'get_balance', arguments: { account_id: 'acc-ana-ars' } }));
    expect(body.balance).toBe('1000.00');
  });

  describe("Ana asking for Juan's account by id", () => {
    it.each([
      ['get_balance', { account_id: 'acc-juan-ars' }],
      ['list_transactions', { account_id: 'acc-juan-ars' }],
      ['spending_summary', { account_id: 'acc-juan-ars', from: '2026-10-01', to: '2026-10-31' }],
    ])('%s answers not found, like a missing account', async (name, args) => {
      const client = await connectClient(app, await anaToken());
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(parseText(result).error).toBe('account_not_found');
      expect(JSON.stringify(result)).not.toContain('500.00');
      expect(JSON.stringify(result)).not.toContain('Parrilla');
    });
  });

  it("never returns another customer's transactions in an unfiltered list", async () => {
    const client = await connectClient(app, await anaToken());
    const body = parseText(await client.callTool({ name: 'list_transactions', arguments: {} }));
    const accountIds = (body.transactions as { accountId: string }[]).map((t) => t.accountId);
    expect(new Set(accountIds)).toEqual(new Set(['acc-ana-ars']));
  });

  describe('periods and categories reach the repository', () => {
    const ids = (body: Record<string, unknown>) => (body.transactions as { id: string }[]).map((t) => t.id);
    const listTransactions = async (args: Record<string, unknown>) =>
      parseText(
        await (await connectClient(app, await anaToken())).callTool({ name: 'list_transactions', arguments: args }),
      );

    it('lists only the period, both days inclusive, newest first', async () => {
      // 1 is booked the day before `from`, 5 the day after `to`, 6 late on the bank's last day.
      expect(ids(await listTransactions({ from: '2026-10-06', to: '2026-10-31' }))).toEqual(['6', '4', '3']);
      expect(ids(await listTransactions({ from: '2026-10-05', to: '2026-10-20' }))).toEqual(['3', '1']);
    });

    it('applies each bound on its own', async () => {
      expect(ids(await listTransactions({ from: '2026-10-21' }))).toEqual(['5', '6', '4']);
      expect(ids(await listTransactions({ to: '2026-10-05' }))).toEqual(['1']);
    });

    it('filters by category', async () => {
      expect(ids(await listTransactions({ category: 'supermercado' }))).toEqual(['5', '1']);
    });

    it('matches a valid category whatever its case', async () => {
      expect(ids(await listTransactions({ category: ' Supermercado ' }))).toEqual(['5', '1']);
    });

    it.each(['comida', 'super', ''])('rejects the unknown category %j at the schema', async (category) => {
      const client = await connectClient(app, await anaToken());
      const result = await client.callTool({ name: 'list_transactions', arguments: { category } });
      expect(result.isError).toBe(true);
    });

    it('totals only the debits inside the period, by category', async () => {
      const client = await connectClient(app, await anaToken());
      const body = parseText(
        await client.callTool({ name: 'spending_summary', arguments: { from: '2026-10-06', to: '2026-10-31' } }),
      );
      expect(body.categories).toEqual([
        { category: 'compras', currency: 'ARS', total: '75.00', count: 1 },
        { category: 'restaurantes', currency: 'ARS', total: '40.50', count: 1 },
      ]);
    });

    describe('a debit at 22:30 on 31 Oct in Buenos Aires (1 Nov in UTC)', () => {
      const spending = async (from: string, to: string) =>
        parseText(
          await (
            await connectClient(app, await anaToken())
          ).callTool({
            name: 'spending_summary',
            arguments: { from, to },
          }),
        ).categories as { category: string }[];

      it('counts in October, not November', async () => {
        expect(ids(await listTransactions({ from: '2026-10-31', to: '2026-10-31' }))).toEqual(['6', '4']);
        expect(ids(await listTransactions({ from: '2026-11-01', to: '2026-11-30' }))).toEqual(['5']);
        expect((await spending('2026-10-01', '2026-10-31')).map((c) => c.category)).toContain('compras');
        expect((await spending('2026-11-01', '2026-11-30')).map((c) => c.category)).not.toContain('compras');
      });

      it('comes back with the bank offset, so the local date reads 31 Oct', async () => {
        const [first] = (await listTransactions({ from: '2026-10-31', to: '2026-10-31' })).transactions as {
          bookedAt: string;
        }[];
        expect(first?.bookedAt).toBe('2026-10-31T22:30:00.000-03:00');
      });
    });
  });

  describe('publishes the categories where the model reads them', () => {
    it('as an enum on list_transactions and in both descriptions', async () => {
      const { tools } = await (await connectClient(app, await anaToken())).listTools();
      const byName = new Map(tools.map((t) => [t.name, t]));
      const property = byName.get('list_transactions')?.inputSchema.properties?.category as { enum?: string[] };
      expect(property.enum).toEqual([...TRANSACTION_CATEGORIES]);
      for (const name of ['list_transactions', 'spending_summary']) {
        const description = byName.get(name)?.description ?? '';
        for (const c of TRANSACTION_CATEGORIES) expect(description).toContain(c);
        expect(description).toContain("Map the customer's words to one of these");
      }
    });

    it("in the bot's accounts skill", async () => {
      const skill = await readFile(new URL('../../../../bot/skills/accounts.md', import.meta.url), 'utf8');
      for (const c of TRANSACTION_CATEGORIES) expect(skill).toContain(c);
      expect(skill).toContain("Map the customer's words to one of these");
    });
  });

  it('refuses a call without the accounts:read scope', async () => {
    const client = await connectClient(app, await keys.sign({ aud: AUDIENCE, sub: 'ana', scope: 'payments:read' }));
    const result = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(parseText(result).error).toBe('insufficient_scope');
  });

  it('rejects a limit above the maximum', async () => {
    const client = await connectClient(app, await anaToken());
    const result = await client.callTool({ name: 'list_transactions', arguments: { limit: 500 } });
    expect(result.isError).toBe(true);
  });

  it('rejects a token for another audience at the HTTP layer', async () => {
    const token = await keys.sign({ aud: 'mcp-payments', sub: 'ana', scope: 'accounts:read' });
    await expect(connectClient(app, token)).rejects.toThrow();
  });

  it('rejects the bot token (aud=bot): the bot must exchange, never pass through', async () => {
    const token = await keys.sign({ aud: 'bot', sub: 'ana', scope: 'chat', act: undefined });
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });
});
