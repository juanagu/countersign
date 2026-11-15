import { expect, test } from '@playwright/test';
import { ask, expectNoHorizontalScroll, signIn, snapshot } from './support';

test('scenario 1: a knowledge answer cites its sources', async ({ page }, info) => {
  await signIn(page, 'Ana Gómez');
  await ask(page, '¿Cuánto cuesta una transferencia internacional?');
  const sources = page.getByRole('complementary', { name: 'Fuentes' }).last();
  await expect(sources.getByRole('listitem').first()).toBeVisible();
  await snapshot(page, info, 'knowledge');
  await expectNoHorizontalScroll(page);
});
