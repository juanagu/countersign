import { decodeJwt } from 'jose';
import { describe, expect, it } from 'vitest';
import { BOT_SECRET, createStack, GATEWAY_SECRET } from '../../support/stack.js';

describe('the delegation chain at every hop (ADR 017)', () => {
  it('backends see act {mcp-gateway, act {bot}} on the token the gateway exchanged', async () => {
    const stack = await createStack();
    const client = await stack.connect(await stack.gatewayToken('juan'));
    await client.callTool({ name: 'list_beneficiaries', arguments: {} });
    const seen = stack.seen.find((r) => r.host === 'payments.test');
    const claims = decodeJwt((seen?.authorization ?? '').slice('Bearer '.length));
    expect(claims).toMatchObject({
      sub: 'juan',
      aud: 'mcp-payments',
      act: { sub: 'mcp-gateway', act: { sub: 'bot' } },
    });
  });

  describe('a backend refuses', () => {
    it("a token the bot exchanged for the backend itself (today's direct chain)", async () => {
      const stack = await createStack();
      const subject = await stack.issuer.issueBotToken({ sub: 'juan', name: 'Juan' });
      const direct = await stack.exchangeAs('bot', BOT_SECRET, subject, 'mcp-payments');
      await expect(stack.connectBackend('payments.test', direct)).rejects.toThrow();
    });

    it("the gateway's own aud=mcp-gateway token sent straight to it", async () => {
      const stack = await createStack();
      await expect(stack.connectBackend('accounts.test', await stack.gatewayToken('juan'))).rejects.toThrow();
    });

    it('the gateway-exchanged token, once it is for the other backend', async () => {
      const stack = await createStack();
      const viaGateway = await stack.exchangeAs(
        'mcp-gateway',
        GATEWAY_SECRET,
        await stack.gatewayToken('juan'),
        'mcp-accounts',
      );
      await expect(stack.connectBackend('payments.test', viaGateway)).rejects.toThrow();
      await expect((await stack.connectBackend('accounts.test', viaGateway)).listTools()).resolves.toBeDefined();
    });
  });

  describe('the gateway refuses', () => {
    it('a token exchanged for a backend audience instead of the gateway', async () => {
      const stack = await createStack();
      const subject = await stack.issuer.issueBotToken({ sub: 'juan', name: 'Juan' });
      const backendToken = await stack.exchangeAs('bot', BOT_SECRET, subject, 'mcp-accounts');
      await expect(stack.connect(backendToken)).rejects.toThrow();
    });

    it('the bot token itself (aud=bot)', async () => {
      const stack = await createStack();
      await expect(stack.connect(await stack.issuer.issueBotToken({ sub: 'juan', name: 'Juan' }))).rejects.toThrow();
    });

    it('a gateway-audience token whose actor chain is not exactly [bot]', async () => {
      const stack = await createStack();
      const chained = await stack.issuer.issueExchanged({
        sub: 'juan',
        audience: 'mcp-gateway',
        scopes: ['accounts:read'],
        act: { sub: 'mcp-gateway', act: { sub: 'bot' } },
        notAfter: Math.floor(Date.now() / 1000) + 300,
      });
      await expect(stack.connect(chained?.token ?? '')).rejects.toThrow();
    });

    it('a session token (aud=bff)', async () => {
      const stack = await createStack();
      const session = await stack.issuer.issueSession({ id: 'juan', name: 'Juan' });
      await expect(stack.connect(session)).rejects.toThrow();
    });

    it('requests without a bearer token', async () => {
      const stack = await createStack();
      const res = await stack.gateway.request('/mcp', { method: 'POST', body: '{}' });
      expect(res.status).toBe(401);
    });
  });
});
