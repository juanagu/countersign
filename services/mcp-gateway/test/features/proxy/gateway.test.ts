import { describe, expect, it } from 'vitest';
import { createStack, parseText } from '../../support/stack.js';

describe('gateway in front of the real mcp-accounts and mcp-payments', () => {
  it('lists every backend tool unprefixed, with schemas and the risk tier passed through', async () => {
    const stack = await createStack();
    const client = await stack.connect(await stack.gatewayToken('juan'));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'execute_transfer',
      'get_balance',
      'list_accounts',
      'list_beneficiaries',
      'list_transactions',
      'prepare_transfer',
      'spending_summary',
    ]);
    const tiers = Object.fromEntries(tools.map((t) => [t.name, t._meta?.['bank/riskTier']]));
    expect(tiers).toMatchObject({ list_accounts: 'T1', prepare_transfer: 'T2', execute_transfer: 'T3' });
    const direct = tools.find((t) => t.name === 'execute_transfer');
    expect(direct?.inputSchema).toMatchObject({ required: ['draft_id', 'step_up_token'] });
  });

  it('passes a T3 execute_transfer through with its step-up argument untouched', async () => {
    const stack = await createStack();
    const client = await stack.connect(await stack.gatewayToken('juan'));
    const draft = parseText(
      await client.callTool({
        name: 'prepare_transfer',
        arguments: {
          source_account_id: 'acc-juan-ars',
          beneficiary_id: 'ben-juan-ana',
          amount: 50000,
          currency: 'ARS',
        },
      }),
    );
    const stepUp = await stack.issuer.issueStepUp('juan', {
      type: 'transfer',
      draft_id: draft.draft_id as string,
      amount: '50000.00',
      currency: 'ARS',
      beneficiary_id: 'ben-juan-ana',
    });

    const result = await client.callTool({
      name: 'execute_transfer',
      arguments: { draft_id: draft.draft_id, step_up_token: stepUp },
    });

    expect(result.isError).toBeFalsy();
    expect(parseText(result)).toMatchObject({ transfer_id: expect.any(String), amount: '50000.00' });
    expect(stack.transfersRepo.debits).toHaveLength(1);
    const call = stack.seen
      .filter((r) => r.host === 'payments.test' && r.body)
      .map((r) => JSON.parse(r.body) as { method?: string; params?: { name?: string; arguments?: unknown } })
      .find((b) => b.params?.name === 'execute_transfer');
    expect(call?.params?.arguments).toEqual({ draft_id: draft.draft_id, step_up_token: stepUp });
  });

  it('a step-up token cannot be replayed through the gateway: the backend still spends its jti once', async () => {
    const stack = await createStack();
    const client = await stack.connect(await stack.gatewayToken('juan'));
    const draft = parseText(
      await client.callTool({
        name: 'prepare_transfer',
        arguments: { source_account_id: 'acc-juan-ars', beneficiary_id: 'ben-juan-ana', amount: 100, currency: 'ARS' },
      }),
    );
    const stepUp = await stack.issuer.issueStepUp('juan', {
      type: 'transfer',
      draft_id: draft.draft_id as string,
      amount: '100.00',
      currency: 'ARS',
      beneficiary_id: 'ben-juan-ana',
    });
    const args = { draft_id: draft.draft_id, step_up_token: stepUp };
    await client.callTool({ name: 'execute_transfer', arguments: args });
    const again = await client.callTool({ name: 'execute_transfer', arguments: args });
    expect(stack.transfersRepo.debits).toHaveLength(1);
    expect(again.isError ? parseText(again).error : 'ok').not.toBe(undefined);
    const executeCalls = stack.seen.filter((r) => r.host === 'payments.test' && r.body.includes('"execute_transfer"'));
    expect(executeCalls).toHaveLength(2); // two calls from the client, each forwarded once: no gateway retry
  });

  it("returns only the caller's own data: identity comes from the token", async () => {
    const stack = await createStack();
    const ana = await stack.connect(await stack.gatewayToken('ana'));
    const body = parseText(await ana.callTool({ name: 'list_accounts', arguments: {} }));
    expect(JSON.stringify(body)).toContain('acc-ana-ars');
    expect(JSON.stringify(body)).not.toContain('juan');
  });

  it('never forwards the incoming token: each backend gets one exchanged for its own audience', async () => {
    const stack = await createStack();
    const incoming = await stack.gatewayToken('juan');
    const client = await stack.connect(incoming);
    await client.callTool({ name: 'list_accounts', arguments: {} });
    await client.callTool({ name: 'list_beneficiaries', arguments: {} });

    const backendAuth = stack.seen.filter(
      (r) => r.host.endsWith('.test') && r.host !== 'idp.test' && r.host !== 'gateway.test',
    );
    expect(backendAuth.length).toBeGreaterThan(0);
    for (const request of backendAuth) {
      expect(request.authorization).toMatch(/^Bearer /);
      expect(request.authorization).not.toContain(incoming);
    }
    const audiences = new Set(
      backendAuth.map((r) => stack.audienceOf((r.authorization ?? '').slice('Bearer '.length))),
    );
    expect(audiences).toEqual(new Set(['mcp-accounts', 'mcp-payments']));
  });

  it('exchanges once per backend and inbound token, not once per call', async () => {
    const stack = await createStack();
    const client = await stack.connect(await stack.gatewayToken('juan'));
    for (let i = 0; i < 3; i++) await client.callTool({ name: 'list_accounts', arguments: {} });
    const exchanges = stack.seen.filter((r) => r.host === 'idp.test' && r.body.includes('audience=mcp-accounts'));
    expect(exchanges).toHaveLength(1);
  });

  it("never reuses one customer's backend token for another", async () => {
    const stack = await createStack();
    const juan = await stack.connect(await stack.gatewayToken('juan'));
    const ana = await stack.connect(await stack.gatewayToken('ana'));
    await juan.callTool({ name: 'list_accounts', arguments: {} });
    const anaAccounts = parseText(await ana.callTool({ name: 'list_accounts', arguments: {} }));
    expect(JSON.stringify(anaAccounts)).toContain('acc-ana-ars');
    const accountTokens = stack.seen
      .filter((r) => r.host === 'accounts.test')
      .map((r) => (r.authorization ?? '').slice('Bearer '.length));
    const subjects = new Set(
      accountTokens.map((t) => JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString()).sub),
    );
    expect(subjects).toEqual(new Set(['juan', 'ana']));
  });

  it('forwards the caller traceparent to the backends', async () => {
    const stack = await createStack();
    const traceparent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
    const client = await stack.connect(await stack.gatewayToken('juan'), { traceparent });
    await client.callTool({ name: 'list_accounts', arguments: {} });
    const backendRequests = stack.seen.filter((r) => r.host === 'accounts.test');
    expect(backendRequests.length).toBeGreaterThan(0);
    for (const request of backendRequests) expect(request.traceparent).toBe(traceparent);
  });
});
