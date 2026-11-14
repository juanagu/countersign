import { expect, test } from '@playwright/test';
import { expectNoHorizontalScroll, signIn, snapshot } from './support';

test('the welcome screen greets by name and its tiles send real messages', async ({ page }, info) => {
  await signIn(page, 'Ana Gómez');
  await expect(page.getByRole('heading', { name: 'Hola, Ana' })).toBeVisible();
  await expect(page.getByRole('list').getByRole('button')).toHaveCount(6);
  await snapshot(page, info, 'welcome');
  await expectNoHorizontalScroll(page);

  await page.getByRole('button', { name: 'Mis saldos' }).click();
  await expect(page.getByTestId('copilot-user-message')).toHaveText('¿Cuánto tengo en mis cuentas?');
  await expect(page.getByRole('heading', { name: 'Hola, Ana' })).toHaveCount(0);
});

test('Nueva conversación returns to the welcome screen', async ({ page }) => {
  await signIn(page, 'Ana Gómez');
  await page.getByRole('button', { name: 'Perdí mi tarjeta' }).click();
  await expect(page.getByTestId('copilot-user-message')).toHaveCount(1);
  await page.getByRole('button', { name: 'Nueva conversación' }).click();
  await expect(page.getByRole('heading', { name: 'Hola, Ana' })).toBeVisible();
  await expect(page.getByTestId('copilot-user-message')).toHaveCount(0);
});
