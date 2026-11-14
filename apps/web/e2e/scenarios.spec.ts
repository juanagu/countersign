import { expect, test } from '@playwright/test';
import { ask, expectNoHorizontalScroll, signIn, snapshot } from './support';

test('scenario 2: spending renders an A2UI chart', async ({ page }, info) => {
  await signIn(page, 'Ana Gómez');
  await ask(page, '¿En qué gasté el mes pasado?');
  const card = page.locator('.gen-card').last();
  await expect(card.locator('.gen-chart__bar').first()).toBeVisible();
  await snapshot(page, info, 'spending');
  await expectNoHorizontalScroll(page);
});

test('scenario 3: transfer with confirm card, PIN step-up and receipt', async ({ page }, info) => {
  await signIn(page, 'Juan Pérez');
  await ask(page, 'Mandale 50.000 a Ana');
  const card = page.getByLabel('Confirmar transferencia');
  await expect(card).toBeVisible();
  await expect(card.getByRole('button', { name: 'Cancelar' })).toBeEnabled();
  await snapshot(page, info, 'transfer-confirm');

  // The PIN dialog lives inside the card, so its own Confirmar is a second match: the card's is the first.
  const confirm = card.getByRole('button', { name: 'Confirmar' }).first();
  await confirm.click();
  await expect(confirm).toBeDisabled();
  await page.getByLabel('PIN de 6 dígitos').fill('123456');
  await snapshot(page, info, 'transfer-pin');
  await page.getByRole('dialog').getByRole('button', { name: 'Confirmar' }).click();

  await expect(page.getByLabel('Comprobante de transferencia')).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(page.getByText('Confirmaste la transferencia con tu PIN.')).toBeVisible();
  await snapshot(page, info, 'transfer-receipt');
  await expectNoHorizontalScroll(page);
});

test('scenario 3b: cancelling the confirm card leaves one line and no receipt', async ({ page }, info) => {
  await signIn(page, 'Juan Pérez');
  await ask(page, 'Mandale 50.000 a Ana');
  const card = page.getByLabel('Confirmar transferencia');
  await card.getByRole('button', { name: 'Cancelar' }).click();

  await expect(page.getByText(/^No se envió la transferencia de \$ 50\.000,00 a Ana Gómez\.$/)).toBeVisible();
  await expect(card).toHaveCount(0);
  await expect(page.getByLabel('Comprobante de transferencia')).toHaveCount(0);
  await snapshot(page, info, 'transfer-cancelled');
  await expectNoHorizontalScroll(page);
});
