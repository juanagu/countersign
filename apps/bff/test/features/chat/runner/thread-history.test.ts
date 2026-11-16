import { describe, expect, it, vi } from 'vitest';
import { BotThreadHistory } from '../../../../src/features/chat/runner/thread-history.js';
import { TokenIssuer } from '../../../../src/features/idp/token-issuer.js';
import { silentLogger, TEST_ISSUER, testSession } from '../../../support/build-app.js';

const MESSAGES = [{ id: 'm1', role: 'user', content: 'hola' }];

async function setup() {
  const issuer = await TokenIssuer.create(TEST_ISSUER);
  const fetchImpl = vi.fn(async () => Response.json({ messages: MESSAGES }));
  const history = new BotThreadHistory(issuer, 'http://bot.invalid/agent', silentLogger, fetchImpl as typeof fetch);
  return { issuer, fetchImpl, history };
}

describe('BotThreadHistory', () => {
  it("restores with a token for the owner in the caller's session, read from the connect headers", async () => {
    const { issuer, fetchImpl, history } = await setup();
    const caller = testSession('ana');
    const headers = { Authorization: `Bearer ${await issuer.issueBotToken(caller)}` };

    expect(await history.messagesFor('t1', 'ana', headers)).toEqual(MESSAGES);

    const sent = (fetchImpl.mock.calls[0] as unknown as [URL, RequestInit])[1].headers as Record<string, string>;
    const minted = await issuer.verifyBotToken(sent.authorization?.replace('Bearer ', '') ?? '');
    expect(minted).toEqual(caller);
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
