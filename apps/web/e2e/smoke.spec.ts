import { expect, test } from '@playwright/test';
import { ask, expectNoHorizontalScroll, signIn, snapshot } from './support';

test.describe('@smoke', () => {
  test('signs in and streams an answer', async ({ page }, info) => {
    // nginx's Content-Security-Policy must not block anything the app itself loads (fonts, styles, SSE).
    const blocked: string[] = [];
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) blocked.push(message.text());
    });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Asistente bancario' })).toBeVisible();
    await snapshot(page, info, 'login');
    await expectNoHorizontalScroll(page);

    await signIn(page, 'Ana Gómez');
    await expect(page.getByRole('button', { name: 'Salir' })).toBeVisible();
    await expectNoHorizontalScroll(page);

    await ask(page, 'Hola, ¿qué podés hacer por mí? Respondé en dos oraciones.');
    const answer = page.getByTestId('copilot-assistant-message').last();
    await expect(answer).not.toBeEmpty();
    await snapshot(page, info, 'chat');
    await expectNoHorizontalScroll(page);
    expect(blocked).toEqual([]);
  });

  test('a signed-out visitor sees only the login', async ({ page }) => {
    await page.context().clearCookies();
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Ana Gómez' })).toBeVisible();
    await expect(page.getByPlaceholder('Escribí tu consulta…')).toHaveCount(0);
  });
});
