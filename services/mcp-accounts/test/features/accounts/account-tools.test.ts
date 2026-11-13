import { createJwtVerifier } from '@poc/mcp-kit';
import { createTestKeys, TEST_ISSUER, type TestKeys } from '@poc/mcp-kit/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { AUDIENCE, createApp } from '../../../src/app.js';
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
      { id: 'acc-ana-ars', kind: 'savings', currency: 'ARS', alias: 'Pesos', number: '****4521' },
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
      // 1 is booked the day before `from`, 5 the day after `to`, 3 late on a day inside it.
      expect(ids(await listTransactions({ from: '2026-10-06', to: '2026-10-31' }))).toEqual(['4', '3']);
      expect(ids(await listTransactions({ from: '2026-10-05', to: '2026-10-20' }))).toEqual(['3', '1']);
    });

    it('applies each bound on its own', async () => {
      expect(ids(await listTransactions({ from: '2026-10-21' }))).toEqual(['5', '4']);
      expect(ids(await listTransactions({ to: '2026-10-05' }))).toEqual(['1']);
    });

    it('filters by category', async () => {
      expect(ids(await listTransactions({ category: 'supermercado' }))).toEqual(['5', '1']);
    });

    it('totals only the debits inside the period, by category', async () => {
      const client = await connectClient(app, await anaToken());
      const body = parseText(
        await client.callTool({ name: 'spending_summary', arguments: { from: '2026-10-06', to: '2026-10-31' } }),
      );
      expect(body.categories).toEqual([{ category: 'restaurantes', currency: 'ARS', total: '40.50', count: 1 }]);
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
