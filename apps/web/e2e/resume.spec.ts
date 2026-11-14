import { expect, test } from '@playwright/test';
import { ask, signIn, snapshot } from './support';

// Scenario 5 in a browser (ADR 015). Not run in CI's smoke tier: it needs the live stack and the model.
test('an offline blip mid-answer resumes, and a reload restores the conversation', async ({ page, context }) => {
  await signIn(page, 'Ana Gómez');
  await ask(page, 'Explicame en cinco oraciones cómo funcionan las transferencias internacionales.');
  const answer = page.getByTestId('copilot-assistant-message').last();
  await expect(answer).not.toBeEmpty({ timeout: 30_000 });

  await context.setOffline(true);
  await page.waitForTimeout(1_500);
  await context.setOffline(false);

  await expect(page.getByPlaceholder('Escribí tu consulta…')).toBeEnabled({ timeout: 60_000 });
  const resumed = (await answer.textContent()) ?? '';
  expect(resumed.length).toBeGreaterThan(0);

  await page.reload();
  await expect(page.getByText('cinco oraciones', { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(answer).toHaveText(resumed);
});

test('offline, a new question shows the connection pill, which goes away once the browser is back', async ({
  page,
  context,
}, info) => {
  await signIn(page, 'Ana Gómez');
  await context.setOffline(true);
  await ask(page, 'hola');
  const pill = page.getByRole('status').filter({ hasText: 'Sin conexión. Reintentamos al reconectar.' });
  await expect(pill).toBeVisible();
  await snapshot(page, info, 'connection-offline');
  await context.setOffline(false);
  await expect(pill).toBeHidden({ timeout: 30_000 });
});
