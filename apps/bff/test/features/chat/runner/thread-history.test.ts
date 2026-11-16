import { decodeJwt } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { BotThreadHistory } from '../../../../src/features/chat/runner/thread-history.js';
import { TokenIssuer } from '../../../../src/features/idp/token-issuer.js';
import { silentLogger, TEST_ISSUER, testSession } from '../../../support/build-app.js';
import { MemoryRevocationStore } from '../../../support/memory-revocation-store.js';
import { capturingLogger, UnavailableRevocationStore } from '../../../support/revocation-doubles.js';

const MESSAGES = [{ id: 'm1', role: 'user', content: 'hola' }];

async function setup(logger = silentLogger, revocations = new MemoryRevocationStore()) {
  const issuer = await TokenIssuer.create(TEST_ISSUER);
  const fetchImpl = vi.fn(async () => Response.json({ messages: MESSAGES }));
  const history = new BotThreadHistory(
    issuer,
    revocations,
    'http://bot.invalid/agent',
    logger,
    fetchImpl as typeof fetch,
  );
  return { issuer, fetchImpl, history, revocations };
}

const sentToken = (fetchImpl: ReturnType<typeof vi.fn>) =>
  (
    (fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].headers as Record<string, string>
  ).authorization?.replace('Bearer ', '') ?? '';

describe('BotThreadHistory', () => {
  it('restores nothing for a caller whose session was logged out, and none when the store cannot say', async () => {
    const { issuer, fetchImpl, history, revocations } = await setup();
    const caller = testSession('ana');
    const headers = { Authorization: `Bearer ${await issuer.issueBotToken(caller)}` };
    await revocations.revoke(caller.sid, 60);

    expect(await history.messagesFor('t1', 'ana', headers)).toEqual([]);

    const down = await setup(silentLogger, new UnavailableRevocationStore() as unknown as MemoryRevocationStore);
    expect(await down.history.messagesFor('t1', 'ana', headers)).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(down.fetchImpl).not.toHaveBeenCalled();
  });

  it("restores with a token for the owner in the caller's session, read from the connect headers", async () => {
    const { issuer, fetchImpl, history } = await setup();
    const caller = testSession('ana');
    const headers = { Authorization: `Bearer ${await issuer.issueBotToken(caller)}` };

    expect(await history.messagesFor('t1', 'ana', headers)).toEqual(MESSAGES);

    const minted = await issuer.verifyBotToken(sentToken(fetchImpl));
    expect(minted).toMatchObject(caller);
  });

  it('never mints a restore token that outlives the caller token it came from', async () => {
    const { issuer, fetchImpl, history } = await setup();
    const callerExp = Math.floor(Date.now() / 1000) + 60;
    const headers = { Authorization: `Bearer ${await issuer.issueBotToken(testSession('ana'), callerExp)}` };

    await history.messagesFor('t1', 'ana', headers);

    expect(decodeJwt(sentToken(fetchImpl)).exp).toBeLessThanOrEqual(callerExp);
  });

  it('mints no bot token under a cap that has already passed', async () => {
    const { issuer } = await setup();
    await expect(issuer.issueBotToken(testSession('ana'), Math.floor(Date.now() / 1000))).rejects.toThrow('expired');
  });

  it('logs at error, not warn, when the connect carries no caller token at all', async () => {
    const { logger, lines } = capturingLogger();
    const { history } = await setup(logger);
    expect(await history.messagesFor('t1', 'ana', {})).toEqual([]);
    expect(lines.map((line) => JSON.parse(line) as { level: number })).toMatchObject([{ level: 50 }]);
  });

  it.each([
    ['no authorization header', async () => ({})],
    [
      'a token that is not a bot token',
      async (i: TokenIssuer) => ({
        Authorization: `Bearer ${(await i.issueSession({ id: 'ana', name: 'Ana' })).token}`,
      }),
    ],
    [
      'a bot token for another user',
      async (i: TokenIssuer) => ({ Authorization: `Bearer ${await i.issueBotToken(testSession('juan'))}` }),
    ],
    [
      'a bot token without a sid',
      async (i: TokenIssuer) => ({ Authorization: `Bearer ${await i['sign']({ scope: 'chat' }, 'ana', 'bot', 300)}` }),
    ],
    [
      'a token from another IdP',
      async () => ({
        Authorization: `Bearer ${await (await TokenIssuer.create(TEST_ISSUER)).issueBotToken(testSession('ana'))}`,
      }),
    ],
  ])('gets no history, and calls the bot for nothing, with %s', async (_, headersFor) => {
    const { issuer, fetchImpl, history } = await setup();
    expect(await history.messagesFor('t1', 'ana', await headersFor(issuer))).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
