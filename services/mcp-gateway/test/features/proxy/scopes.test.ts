import { decodeJwt } from 'jose';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../../src/features/proxy/rate-limiter.js';
import { createStack, parseText, type Stack } from '../../support/stack.js';

const ACCOUNTS_ONLY = 'accounts:read';
const BEFORE_APPROVAL = 'accounts:read beneficiaries:read transfers:prepare';
const ACCOUNT_TOOLS = ['get_balance', 'list_accounts', 'list_transactions', 'spending_summary'];
const ARGS = { source_account_id: 'acc-juan-ars', beneficiary_id: 'ben-juan-ana', amount: 100, currency: 'ARS' };

const hostCalls = (stack: Stack, host: string, method?: string) =>
  stack.seen.filter((r) => r.host === host && (!method || r.body.includes(`"method":"${method}"`)));
const scopeOf = (authorization: string | null) =>
  new Set(String(decodeJwt((authorization ?? '').slice('Bearer '.length)).scope).split(' '));

/** A full-ceiling caller lists once so the shared catalog holds every backend, as it does in service. */
async function warm(stack: Stack) {
  await (await stack.connect(await stack.gatewayToken('juan'))).listTools();
  stack.seen.length = 0;
}

describe('the gateway lists and calls by token scope', () => {
  it('lists every tool for a token holding every pre-approval scope plus transfers:execute', async () => {
    const stack = await createStack();
    const names = (await (await stack.connect(await stack.gatewayToken('juan'))).listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual(
      [...ACCOUNT_TOOLS, 'execute_transfer', 'list_beneficiaries', 'prepare_transfer'].sort(),
    );
  });

  it('an accounts:read token lists exactly the accounts tools and cannot call a payments tool', async () => {
    const stack = await createStack({ proxy: { limiter: new RateLimiter({ T2: { max: 1, windowMs: 60_000 } }) } });
    await warm(stack);
    const client = await stack.connect(await stack.gatewayToken('juan', ACCOUNTS_ONLY));
    expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(ACCOUNT_TOOLS);
    stack.seen.length = 0;

    for (let i = 0; i < 3; i++) {
      const refused = await client.callTool({ name: 'prepare_transfer', arguments: ARGS });
      expect(refused.isError).toBe(true);
      expect(parseText(refused)).toEqual({ error: 'insufficient_scope', scope: 'transfers:prepare' });
    }
    expect(hostCalls(stack, 'payments.test')).toEqual([]);
    expect(
      stack.seen.filter((r) => r.host === 'idp.test' && new URLSearchParams(r.body).get('audience') === 'mcp-payments'),
    ).toEqual([]);

    // Three refusals did not use the one T2 allowance this customer has.
    const allowed = await (
      await stack.connect(await stack.gatewayToken('juan', BEFORE_APPROVAL))
    ).callTool({
      name: 'prepare_transfer',
      arguments: ARGS,
    });
    expect(allowed.isError).toBeFalsy();
  });

  it('a refused call is audited as insufficient_scope', async () => {
    const lines: string[] = [];
    const logger = pino(
      { level: 'info' },
      new Writable({
        write(chunk, _e, done) {
          lines.push(String(chunk));
          done();
        },
      }),
    );
    const stack = await createStack({ logger });
    await warm(stack);
    await (
      await stack.connect(await stack.gatewayToken('juan', ACCOUNTS_ONLY))
    ).callTool({
      name: 'prepare_transfer',
      arguments: ARGS,
    });
    expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({
      outcome: 'insufficient_scope',
      tool: 'prepare_transfer',
      backend: 'payments',
      tier: 'T2',
    });
  });

  it('a pre-approval token lists execute_transfer but cannot call it, and the step-up jti stays unspent', async () => {
    const stack = await createStack();
    const before = await stack.connect(await stack.gatewayToken('juan', BEFORE_APPROVAL));
    expect((await before.listTools()).tools.map((t) => t.name)).toContain('execute_transfer');
    const draft = parseText(await before.callTool({ name: 'prepare_transfer', arguments: ARGS }));
    const stepUp = await stack.issuer.issueStepUp('juan', {
      type: 'transfer',
      draft_id: draft.draft_id as string,
      amount: '100.00',
      currency: 'ARS',
      beneficiary_id: 'ben-juan-ana',
    });
    const args = { draft_id: draft.draft_id, step_up_token: stepUp };
    stack.seen.length = 0;

    const refused = await before.callTool({ name: 'execute_transfer', arguments: args });
    expect(parseText(refused)).toEqual({ error: 'insufficient_scope', scope: 'transfers:execute' });
    expect(hostCalls(stack, 'payments.test')).toEqual([]);
    expect(stack.transfersRepo.debits).toEqual([]);

    const approved = await stack.connect(await stack.gatewayToken('juan', 'transfers:execute'));
    const result = await approved.callTool({ name: 'execute_transfer', arguments: args });
    expect(result.isError).toBeFalsy();
    expect(stack.transfersRepo.debits).toHaveLength(1);
  });

  it('gives each backend a token with only the scopes the gateway token held', async () => {
    const stack = await createStack();
    await warm(stack);
    const client = await stack.connect(await stack.gatewayToken('juan', 'accounts:read transfers:prepare'));
    await client.listTools();
    await client.callTool({ name: 'list_accounts', arguments: {} });
    await client.callTool({ name: 'prepare_transfer', arguments: ARGS });

    for (const [host, expected] of [
      ['accounts.test', 'accounts:read'],
      ['payments.test', 'transfers:prepare'],
    ] as const) {
      const scopes = hostCalls(stack, host).map((r) => scopeOf(r.authorization));
      expect(scopes.length).toBeGreaterThan(0);
      for (const set of scopes) expect([...set]).toEqual([expected]);
    }
  });

  it('still asks the IdP for a backend the token cannot list, and logs the refusal as invalid_scope', async () => {
    const lines: string[] = [];
    const logger = pino(
      { level: 'info' },
      new Writable({
        write(chunk, _e, done) {
          lines.push(String(chunk));
          done();
        },
      }),
    );
    const stack = await createStack({ logger });
    await warm(stack);
    lines.length = 0;
    await (await stack.connect(await stack.gatewayToken('juan', ACCOUNTS_ONLY))).listTools();

    // A stale or empty last-good entry must be able to heal, so the catalog never skips the refresh.
    expect(stack.seen.filter((r) => new URLSearchParams(r.body).get('audience') === 'mcp-payments')).not.toEqual([]);
    expect(hostCalls(stack, 'payments.test')).toEqual([]);
    expect(lines.map((l) => JSON.parse(l))).toContainEqual(
      expect.objectContaining({ backend: 'payments', oauth_error: 'invalid_scope', msg: 'token exchange failed' }),
    );
  });

  it('serves a payments call when the catalog was first filled by an accounts-only caller', async () => {
    const stack = await createStack();
    await (await stack.connect(await stack.gatewayToken('juan', ACCOUNTS_ONLY))).listTools();
    const client = await stack.connect(await stack.gatewayToken('juan', BEFORE_APPROVAL));
    const result = await client.callTool({ name: 'prepare_transfer', arguments: ARGS });
    expect(result.isError).toBeFalsy();
    expect(parseText(result).draft_id).toBeDefined();
  });

  it('an execute-only token lists exactly execute_transfer', async () => {
    const stack = await createStack();
    await warm(stack);
    const client = await stack.connect(await stack.gatewayToken('juan', 'transfers:execute'));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['execute_transfer']);
  });

  it('serves a first caller whose token matches no backend scope an empty list, not an error', async () => {
    const stack = await createStack();
    const client = await stack.connect(await stack.gatewayToken('juan', 'beneficiaries:read'));
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['list_beneficiaries']);
  });

  it('drops a tool without a bank/scope and answers unknown_tool for it', async () => {
    const stack = await createStack({
      intercept: async (host, request, forward) => {
        const body = await request.clone().text();
        if (host !== 'payments.test' || !body.includes('"tools/list"')) return undefined;
        const json = (await (await forward()).json()) as {
          result: { tools: { name: string; _meta?: Record<string, unknown> }[] };
        };
        for (const tool of json.result.tools) if (tool.name === 'list_beneficiaries') delete tool._meta?.['bank/scope'];
        return Response.json(json);
      },
    });
    const client = await stack.connect(await stack.gatewayToken('juan'));
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('list_beneficiaries');
    expect(parseText(await client.callTool({ name: 'list_beneficiaries', arguments: {} })).error).toBe('unknown_tool');
  });
});
