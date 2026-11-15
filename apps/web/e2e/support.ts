import { expect, type Page, type TestInfo } from '@playwright/test';

export async function signIn(page: Page, name: 'Ana Gómez' | 'Juan Pérez') {
  await page.goto('/');
  await page.getByRole('button', { name }).click();
  await expect(page.getByRole('img', { name })).toBeVisible();
}

export async function ask(page: Page, question: string) {
  const input = page.getByPlaceholder('Escribí tu consulta…');
  await input.fill(question);
  await input.press('Enter');
}

/** Saves a full-page screenshot named after the test and project, for the PR. */
export async function snapshot(page: Page, info: TestInfo, name: string) {
  const dir = process.env.E2E_SCREENSHOT_DIR ?? info.outputDir;
  await page.screenshot({ path: `${dir}/${name}-${info.project.name}.png`, fullPage: true });
}

export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
}
