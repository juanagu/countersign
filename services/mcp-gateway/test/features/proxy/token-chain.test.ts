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
    it.each(['mcp-accounts', 'mcp-payments'] as const)(
      'a token for itself whose act is only bot, as the bot once exchanged directly (%s)',
      async (audience) => {
        const stack = await createStack();
        const direct = await stack.issuer.issueExchanged({
          sub: 'juan',
          audience,
          scopes: ['accounts:read', 'beneficiaries:read', 'transfers:prepare', 'transfers:execute'],
          act: { sub: 'bot' },
          notAfter: Math.floor(Date.now() / 1000) + 300,
        });
        const host = audience === 'mcp-accounts' ? 'accounts.test' : 'payments.test';
        await expect(stack.connectBackend(host, direct?.token ?? '')).rejects.toThrow();
      },
    );

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

  describe('the IdP refuses', () => {
    it.each(['mcp-accounts', 'mcp-payments'])('client bot asking for aud=%s directly', async (audience) => {
      const stack = await createStack();
      const subject = await stack.issuer.issueBotToken({ sub: 'juan', name: 'Juan' });
      await expect(stack.exchangeAs('bot', BOT_SECRET, subject, audience)).rejects.toThrow(/invalid_target/);
    });
  });

  describe('the gateway refuses', () => {
    it('a token exchanged for a backend audience instead of the gateway', async () => {
      const stack = await createStack();
      const backendToken = await stack.issuer.issueExchanged({
        sub: 'juan',
        audience: 'mcp-accounts',
        scopes: ['accounts:read'],
        act: { sub: 'bot' },
        notAfter: Math.floor(Date.now() / 1000) + 300,
      });
      await expect(stack.connect(backendToken?.token ?? '')).rejects.toThrow();
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
