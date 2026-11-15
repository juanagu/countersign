import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../../../src/features/proxy/rate-limiter.js';
import { BACKENDS, createStack, parseText } from '../../support/stack.js';

const callsTo = (stack: Awaited<ReturnType<typeof createStack>>, host: string, method: string) =>
  stack.seen.filter((r) => r.host === host && r.body.includes(`"method":"${method}"`));

function captureLogs() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, done) {
      lines.push(String(chunk));
      done();
    },
  });
  return { lines, logger: pino({ level: 'info' }, stream) };
}

describe('rate limits', () => {
  const T1_ONLY = { T1: { max: 3, windowMs: 60_000 } };

  it('answers rate_limited after the customer’s allowance, without calling the backend', async () => {
    const stack = await createStack({ proxy: { limiter: new RateLimiter(T1_ONLY) } });
    const client = await stack.connect(await stack.gatewayToken('juan'));
    for (let i = 0; i < 3; i++) await client.callTool({ name: 'list_accounts', arguments: {} });
    const before = callsTo(stack, 'accounts.test', 'tools/call').length;

    const refused = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(parseText(refused)).toMatchObject({ error: 'rate_limited', retry_after_seconds: expect.any(Number) });
    expect(callsTo(stack, 'accounts.test', 'tools/call')).toHaveLength(before);
  });

  it('limits per customer: another customer is not affected', async () => {
    const stack = await createStack({ proxy: { limiter: new RateLimiter(T1_ONLY) } });
    const juan = await stack.connect(await stack.gatewayToken('juan'));
    const ana = await stack.connect(await stack.gatewayToken('ana'));
    for (let i = 0; i < 4; i++) await juan.callTool({ name: 'list_accounts', arguments: {} });
    expect((await ana.callTool({ name: 'list_accounts', arguments: {} })).isError).toBeFalsy();
  });

  it('keys the limit on the token, never on a customer named in the arguments', async () => {
    const stack = await createStack({ proxy: { limiter: new RateLimiter(T1_ONLY) } });
    const juan = await stack.connect(await stack.gatewayToken('juan'));
    for (let i = 0; i < 3; i++) {
      await juan.callTool({
        name: 'get_balance',
        arguments: { account_id: 'acc-ana-ars', customer_id: `ana-${i}`, sub: `x${i}` },
      });
    }
    const refused = await juan.callTool({ name: 'list_accounts', arguments: { sub: 'someone-else' } });
    expect(parseText(refused).error).toBe('rate_limited');
  });
});

describe('circuit breaker', () => {
  function downStack() {
    const clock = { t: 0 };
    const down = new Set<string>();
    return {
      clock,
      down,
      options: { down, proxy: { breaker: { now: () => clock.t } } },
    };
  }

  it('opens after five failures: calls answer service_unavailable at once, the other backend still works', async () => {
    const { down, options } = downStack();
    const stack = await createStack(options);
    const client = await stack.connect(await stack.gatewayToken('juan'));
    await client.listTools();
    down.add('payments.test');

    for (let i = 0; i < 5; i++) {
      expect(parseText(await client.callTool({ name: 'list_beneficiaries', arguments: {} }))).toEqual({
        error: 'upstream_error',
        service: 'payments',
      });
    }
    const attempts = stack.seen.filter((r) => r.host === 'payments.test').length;
    const refused = await client.callTool({ name: 'list_beneficiaries', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(parseText(refused)).toEqual({ error: 'service_unavailable', service: 'payments' });
    expect(stack.seen.filter((r) => r.host === 'payments.test')).toHaveLength(attempts);

    expect((await client.callTool({ name: 'list_accounts', arguments: {} })).isError).toBeFalsy();
  });

  it('serves the last good schemas while a backend is down, and reports degraded health', async () => {
    const { down, options } = downStack();
    const stack = await createStack(options);
    const client = await stack.connect(await stack.gatewayToken('juan'));
    const before = (await client.listTools()).tools;
    down.add('payments.test');
    for (let i = 0; i < 5; i++) await client.callTool({ name: 'list_beneficiaries', arguments: {} });

    expect((await client.listTools()).tools).toEqual(before);
    const health = await stack.gateway.request('/health');
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: 'degraded', backends: { accounts: 'ok', payments: 'open' } });
  });

  it('probes after 30 s and closes again when the backend is back', async () => {
    const { down, clock, options } = downStack();
    const stack = await createStack(options);
    const client = await stack.connect(await stack.gatewayToken('juan'));
    await client.listTools();
    down.add('payments.test');
    for (let i = 0; i < 5; i++) await client.callTool({ name: 'list_beneficiaries', arguments: {} });
    down.delete('payments.test');

    expect(parseText(await client.callTool({ name: 'list_beneficiaries', arguments: {} })).error).toBe(
      'service_unavailable',
    );
    clock.t = 30_000;
    expect((await client.callTool({ name: 'list_beneficiaries', arguments: {} })).isError).toBeFalsy();
    expect(await (await stack.gateway.request('/health')).json()).toMatchObject({ status: 'ok' });
  });

  it('counts a 5xx as a failure and a tool error as a success', async () => {
    let broken = false;
    const stack = await createStack({
      intercept: (host, request) =>
        broken && host === 'payments.test' && request.method === 'POST'
          ? Response.json({}, { status: 503 })
          : undefined,
      proxy: { breaker: { failureThreshold: 2 } },
    });
    const client = await stack.connect(await stack.gatewayToken('juan'));
    await client.listTools();
    broken = true;
    for (let i = 0; i < 2; i++) await client.callTool({ name: 'list_beneficiaries', arguments: {} });
    expect(parseText(await client.callTool({ name: 'list_beneficiaries', arguments: {} })).error).toBe(
      'service_unavailable',
    );

    // The backend answering with a tool error is a healthy backend: it never trips its breaker.
    for (let i = 0; i < 3; i++) {
      const refused = await client.callTool({ name: 'get_balance', arguments: { account_id: 'acc-nobody' } });
      expect(parseText(refused).error).toBe('account_not_found');
    }
    expect((await client.callTool({ name: 'list_accounts', arguments: {} })).isError).toBeFalsy();
  });
});

describe('no retries', () => {
  it('forwards a failed tools/call exactly once and reports it', async () => {
    let calls = 0;
    const stack = await createStack({
      intercept: async (host, request, forward) => {
        if (host !== 'payments.test') return undefined;
        const body = await request.clone().text();
        if (!body.includes('"tools/call"')) return undefined;
        calls += 1;
        return forward().then(() => Response.json({}, { status: 500 }));
      },
    });
    const client = await stack.connect(await stack.gatewayToken('juan', 'transfers:execute'));
    const result = await client.callTool({
      name: 'execute_transfer',
      arguments: { draft_id: 'drf_1', step_up_token: 'x' },
    });
    expect(parseText(result)).toEqual({ error: 'upstream_error', service: 'payments' });
    expect(calls).toBe(1);
  });
});

describe('catalog rules', () => {
  const twoBackendsOneName = [BACKENDS[0], { ...BACKENDS[0], name: 'accounts-copy' }] as typeof BACKENDS;

  it('serves neither tool and reports unhealthy when two backends serve the same name', async () => {
    const stack = await createStack({ backends: twoBackendsOneName });
    const client = await stack.connect(await stack.gatewayToken('juan'));
    expect((await client.listTools()).tools).toEqual([]);
    const call = await client.callTool({ name: 'list_accounts', arguments: {} });
    expect(parseText(call).error).toBe('unknown_tool');
    const health = await stack.gateway.request('/health');
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({
      status: 'unhealthy',
      conflicts: expect.arrayContaining(['list_accounts']),
    });
  });

  it('drops a tool without a risk tier and refuses calls to it', async () => {
    const stack = await createStack({
      intercept: async (host, request, forward) => {
        const body = await request.clone().text();
        if (host !== 'payments.test' || !body.includes('"tools/list"')) return undefined;
        const response = await forward();
        const json = (await response.json()) as { result: { tools: { name: string; _meta?: unknown }[] } };
        for (const tool of json.result.tools) if (tool.name === 'list_beneficiaries') delete tool._meta;
        return Response.json(json);
      },
    });
    const client = await stack.connect(await stack.gatewayToken('juan'));
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names).not.toContain('list_beneficiaries');
    expect(names).toContain('prepare_transfer');
    expect(parseText(await client.callTool({ name: 'list_beneficiaries', arguments: {} })).error).toBe('unknown_tool');
  });
});

describe('audit (rule 7)', () => {
  it('writes one line per call with no argument values, tokens, results or error bodies', async () => {
    const { lines, logger } = captureLogs();
    const stack = await createStack({ logger });
    const incoming = await stack.gatewayToken('juan');
    const headers = { traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' };
    const client = await stack.connect(incoming, headers);
    const args = {
      source_account_id: 'acc-juan-ars',
      beneficiary_id: 'ben-juan-ana',
      amount: 12345.67,
      currency: 'ARS',
    };
    await client.callTool({ name: 'prepare_transfer', arguments: args });
    await client.callTool({ name: 'get_balance', arguments: { account_id: 'acc-secret-nobody' } });
    const approved = await stack.connect(await stack.gatewayToken('juan', 'transfers:execute'), headers);
    await approved.callTool({
      name: 'execute_transfer',
      arguments: { draft_id: 'drf_x', step_up_token: 'step-up-secret' },
    });
    await client.callTool({ name: 'not_a_tool_SSN-123-45', arguments: {} });

    const entries = lines
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.metric === 'mcp.tool_call');
    expect(entries.map((e) => [e.tool, e.backend, e.tier, e.outcome])).toEqual([
      ['prepare_transfer', 'payments', 'T2', 'ok'],
      ['get_balance', 'accounts', 'T1', 'tool_error'],
      ['execute_transfer', 'payments', 'T3', 'tool_error'],
      [undefined, undefined, undefined, 'unknown_tool'],
    ]);
    for (const entry of entries) {
      expect(entry).toMatchObject({ sub: 'juan', trace_id: '0af7651916cd43dd8448eb211c80319c' });
      expect(entry.duration_ms).toEqual(expect.any(Number));
    }
    const everything = lines.join('');
    for (const secret of [
      '12345',
      'acc-juan-ars',
      'ben-juan-ana',
      'acc-secret-nobody',
      'step-up-secret',
      'drf_x',
      'SSN-123',
      incoming,
    ]) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).not.toMatch(/eyJ/); // no JWT of any kind
  });

  it('logs rate-limited and unavailable outcomes too', async () => {
    const { lines, logger } = captureLogs();
    const down = new Set(['payments.test']);
    const stack = await createStack({
      logger,
      down,
      proxy: { limiter: new RateLimiter({ T1: { max: 1, windowMs: 60_000 } }), breaker: { failureThreshold: 1 } },
    });
    const client = await stack.connect(await stack.gatewayToken('juan'));
    await client.callTool({ name: 'list_accounts', arguments: {} });
    await client.callTool({ name: 'list_accounts', arguments: {} });
    const outcomes = lines.map((l) => JSON.parse(l) as { metric?: string; outcome?: string }).filter((e) => e.metric);
    expect(outcomes.map((e) => e.outcome)).toEqual(['ok', 'rate_limited']);
  });
});
