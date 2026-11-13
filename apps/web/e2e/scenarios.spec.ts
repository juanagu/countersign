import { expect, test } from '@playwright/test';
import { ask, expectNoHorizontalScroll, signIn, snapshot } from './support';

test('scenario 2: spending renders an A2UI chart and list', async ({ page }, info) => {
  await signIn(page, 'Ana Gómez');
  await ask(page, '¿En qué gasté el mes pasado?');
  const card = page.locator('.gen-card').last();
  await expect(card.locator('.gen-chart__bar').first()).toBeVisible();
  await expect(card.locator('.gen-list__item').first()).toBeVisible();
  await snapshot(page, info, 'spending');
  await expectNoHorizontalScroll(page);
});

test('scenario 3: transfer with confirm card, PIN step-up and receipt', async ({ page }, info) => {
  await signIn(page, 'Juan Pérez');
  await ask(page, 'Mandale 50.000 a Ana');
  await expect(page.getByLabel('Confirmar transferencia')).toBeVisible();
  const approval = page.getByRole('group', { name: 'Aprobar transferencia' });
  await expect(approval).toBeVisible();
  await snapshot(page, info, 'transfer-confirm');

  await approval.getByRole('button', { name: 'Confirmar' }).click();
  await page.getByLabel('PIN de 6 dígitos').fill('123456');
  await snapshot(page, info, 'transfer-pin');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar' }).click();

  await expect(page.getByLabel('Comprobante de transferencia')).toBeVisible();
  await snapshot(page, info, 'transfer-receipt');
  await expectNoHorizontalScroll(page);
});
