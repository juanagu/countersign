import type { TransferConfirmData } from '@poc/contracts';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalPanel } from '../../../src/features/approval/approval-panel';
import { MissingDraftCard } from '../../../src/features/approval/missing-draft-card';
import { ResolvedLine } from '../../../src/features/approval/resolved-line';
import { hasReceipt } from '../../../src/features/approval/lib/find-confirm-card';
import { PinDialog } from '../../../src/features/approval/pin-dialog';
import { findConfirmCard } from '../../../src/features/approval/lib/find-confirm-card';
import { requestStepUp, StepUpFailed } from '../../../src/features/approval/lib/step-up-api';
import { textOf } from '../../support/html-text';

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
  it('is the card footer: the expiry note, then Cancelar and Confirmar, both enabled', () => {
    const html = renderToString(<ApprovalPanel draft={DRAFT} onDecide={async () => undefined} />);
    expect(textOf(html)).toMatch(/Válida hasta las \d{2}:\d{2}CancelarConfirmar/);
    expect(html).not.toContain('disabled');
    expect(html).not.toContain('Nada se envía');
    expect(html).not.toContain('¿Transferir');
  });
});

describe('MissingDraftCard', () => {
  it('offers only to discard when the draft card is missing', () => {
    const html = renderToString(<MissingDraftCard onDecide={async () => undefined} />);
    expect(html).not.toContain('Confirmar');
    expect(html).toContain('Descartar');
    expect(html).toContain('gen-card');
  });
});

describe('ResolvedLine', () => {
  const line = (state: Parameters<typeof ResolvedLine>[0]['state']) =>
    renderToString(<ResolvedLine state={state} draft={DRAFT} />);

  it.each([
    ['confirmed', 'Confirmaste la transferencia con tu PIN.', 'status'],
    ['not-sent', 'No se envió la transferencia de $ 50.000,00 a Ana Gómez.', 'status'],
    ['expired', 'La transferencia de $ 50.000,00 a Ana Gómez venció sin confirmarse.', 'status'],
    ['resume-failed', 'No pudimos confirmar la transferencia. Pedime de nuevo que la envíe.', 'alert'],
  ] as const)('says %s in one line', (state, text, role) => {
    const html = line(state);
    expect(textOf(html)).toBe(text);
    expect(html).toContain(`role="${role}"`);
  });
});

describe('hasReceipt', () => {
  const receipt = (draftId: string) => ({
    role: 'activity',
    activityType: 'bank-template',
    content: { template: 'transfer-receipt', version: 1, surfaceId: 's', nonce: 'n', data: { draftId } },
  });

  it('is true only for a server receipt of the same draft', () => {
    expect(hasReceipt([card(DRAFT), receipt('drf_1')], 'drf_1')).toBe(true);
    expect(hasReceipt([card(DRAFT), receipt('drf_2')], 'drf_1')).toBe(false);
    expect(hasReceipt([{ ...receipt('drf_1'), role: 'assistant' }], 'drf_1')).toBe(false);
  });
});

describe('PinDialog', () => {
  it('says how long a lockout lasts', () => {
    const noop = () => undefined;
    const html = renderToString(
      <PinDialog draft={DRAFT} pending={false} error="locked" onSubmit={noop} onPinChange={noop} onClose={noop} />,
    );
    expect(html).toContain('Esperá 5 minutos');
  });

  it('summarises the transfer from the draft, so the amount is never model text', () => {
    const noop = () => undefined;
    const html = renderToString(
      <PinDialog draft={DRAFT} pending={false} error={null} onSubmit={noop} onPinChange={noop} onClose={noop} />,
    );
    expect(textOf(html)).toContain('Transferís $ 50.000,00 a Ana Gómez');
  });

  it('marks the field invalid and links the alert when the PIN is wrong', () => {
    const noop = () => undefined;
    const html = renderToString(
      <PinDialog draft={DRAFT} pending={false} error="invalid_pin" onSubmit={noop} onPinChange={noop} onClose={noop} />,
    );
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('El PIN no es correcto.');
  });

  it('shows the pending state on the primary button and disables both', () => {
    const noop = () => undefined;
    const html = renderToString(
      <PinDialog draft={DRAFT} pending error={null} onSubmit={noop} onPinChange={noop} onClose={noop} />,
    );
    expect(html).toContain('Verificando…');
    expect(html.match(/disabled/g)?.length).toBeGreaterThanOrEqual(2);
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
