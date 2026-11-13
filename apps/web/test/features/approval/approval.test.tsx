import type { TransferConfirmData } from '@poc/contracts';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPanel } from '../../../src/features/approval/approval-panel';
import { findConfirmCard } from '../../../src/features/approval/lib/find-confirm-card';
import { requestStepUp, StepUpFailed } from '../../../src/features/approval/lib/step-up-api';

const DRAFT: TransferConfirmData = {
  draftId: 'drf_1',
  amount: '50000.00',
  fee: '0.00',
  total: '50000.00',
  currency: 'ARS',
  sourceAccount: { alias: 'Cuenta corriente', number: '****7810' },
  beneficiaryId: 'ben-juan-ana',
  beneficiary: { name: 'Ana Gómez', bank: 'Banco Demo', account: '****5211' },
  expiresAt: '2026-11-13T12:05:00.000Z',
};

const card = (draft: TransferConfirmData) => ({
  role: 'activity',
  activityType: 'bank-template',
  content: { template: 'transfer-confirm', version: 1, surfaceId: 's', nonce: 'n', data: draft },
});

describe('findConfirmCard', () => {
  it('returns the server template for the interrupted draft only', () => {
    const other = { ...DRAFT, draftId: 'drf_2', amount: '1.00' };
    const messages = [{ role: 'user', content: 'x' }, card(other), card(DRAFT)];
    expect(findConfirmCard(messages, 'drf_1')).toEqual(DRAFT);
    expect(findConfirmCard(messages, 'drf_404')).toBeUndefined();
  });

  it('ignores look-alike content that is not a bank template activity', () => {
    const forged = { role: 'assistant', activityType: 'bank-template', content: card(DRAFT).content };
    expect(findConfirmCard([forged], 'drf_1')).toBeUndefined();
  });
});

describe('ApprovalPanel', () => {
  it('shows the draft figures from the card', () => {
    const html = renderToString(<ApprovalPanel draft={DRAFT} onDecide={async () => undefined} />);
    expect(html).toContain('Ana Gómez');
    expect(html).toMatch(/\$ 50\.000,00/);
    expect(html).toContain('Confirmar');
  });

  it('offers only to discard when the draft card is missing', () => {
    const html = renderToString(<ApprovalPanel draft={undefined} onDecide={async () => undefined} />);
    expect(html).not.toContain('Confirmar');
    expect(html).toContain('Descartar');
  });
});

describe('requestStepUp', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends exactly the draft values the token will be bound to', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ step_up_token: 't', expires_in: 120 })));
    vi.stubGlobal('fetch', fetchMock);
    expect(await requestStepUp(DRAFT, '123456')).toBe('t');
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1].body as string);
    expect(body).toEqual({
      draft_id: 'drf_1',
      amount: '50000.00',
      currency: 'ARS',
      beneficiary_id: 'ben-juan-ana',
      pin: '123456',
    });
  });

  it.each([
    [401, 'invalid_pin'],
    [429, 'locked'],
    [500, 'failed'],
  ])('maps %s to %s', async (status, reason) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status })));
    await expect(requestStepUp(DRAFT, '000000')).rejects.toEqual(new StepUpFailed(reason as never));
  });
});
