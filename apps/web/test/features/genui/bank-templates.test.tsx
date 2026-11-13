import type { BankTemplate } from '@poc/contracts';
import templatesSchema from '@poc/contracts/schemas/bank-templates.json';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { BankTemplateView } from '../../../src/features/genui/bank-templates';

const confirm: BankTemplate = {
  template: 'transfer-confirm',
  version: 1,
  surfaceId: 'draft-drf_1',
  nonce: 'n1',
  data: {
    draftId: 'drf_1',
    amount: '50000.00',
    fee: '0.00',
    total: '50000.00',
    currency: 'ARS',
    sourceAccount: { alias: 'Cuenta corriente en pesos', number: '****7810' },
    beneficiary: { name: 'Ana Gómez', bank: 'Banco Demo', account: '****5211' },
    expiresAt: '2026-11-13T12:05:00.000Z',
  },
};

const schema = z.fromJSONSchema(templatesSchema as Parameters<typeof z.fromJSONSchema>[0]);

describe('bank templates', () => {
  it('renders the confirm card from the draft data', () => {
    const html = renderToString(<BankTemplateView template={confirm} />);
    expect(html).toContain('Ana Gómez');
    expect(html).toMatch(/\$ 50\.000,00/);
    expect(html).toContain('****7810');
  });

  it('accepts a valid template and rejects one with model-shaped junk', () => {
    expect(schema.safeParse(confirm).success).toBe(true);
    expect(schema.safeParse({ ...confirm, data: { ...confirm.data, amount: 'cincuenta mil' } }).success).toBe(false);
    expect(schema.safeParse({ ...confirm, template: 'pin-entry' }).success).toBe(false);
  });
});
