import { describe, expect, it } from 'vitest';
import { toolStatusLabel } from '../../../src/features/chat/lib/tool-labels';

describe('toolStatusLabel', () => {
  it.each([
    ['list_accounts', 'Consultando tus cuentas…'],
    ['get_balance', 'Consultando tus cuentas…'],
    ['list_transactions', 'Consultando tus movimientos…'],
    ['spending_summary', 'Sumando tus gastos…'],
    ['search_knowledge', 'Buscando en la información del banco…'],
    ['list_beneficiaries', 'Preparando la transferencia…'],
    ['prepare_transfer', 'Preparando la transferencia…'],
  ])('labels %s', (tool, label) => {
    expect(toolStatusLabel(tool)).toBe(label);
  });

  it.each(['load_skill', 'render_ui', 'execute_transfer', 'toString', '__proto__'])('says nothing for %s', (tool) => {
    expect(toolStatusLabel(tool)).toBeUndefined();
  });
});
