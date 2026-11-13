import { expect, test } from '@playwright/test';
import { ask, expectNoHorizontalScroll, signIn, snapshot } from './support';

test.describe('@smoke', () => {
  test('signs in and streams an answer', async ({ page }, info) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Asistente bancario' })).toBeVisible();
    await snapshot(page, info, 'login');
    await expectNoHorizontalScroll(page);

    await signIn(page, 'Ana Gómez');
    await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
    await expectNoHorizontalScroll(page);

    await ask(page, 'Hola, ¿qué podés hacer por mí? Respondé en dos oraciones.');
    const answer = page.locator('[data-message-role="assistant"], [data-role="assistant"]').last();
    await expect(answer.or(page.getByText(/banco|cuenta|ayud/i).last())).toBeVisible();
    await snapshot(page, info, 'chat');
    await expectNoHorizontalScroll(page);
  });

  test('a signed-out visitor sees only the login', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Ana Gómez' })).toBeVisible();
    await expect(page.getByPlaceholder('Escribí tu consulta…')).toHaveCount(0);
  });
});
