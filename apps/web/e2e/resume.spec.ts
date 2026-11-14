import { expect, test, type Page } from '@playwright/test';
import { ask, signIn, snapshot } from './support';

type CutWindow = Window & { __cutRunStream?: () => boolean };

// Chrome's offline emulation fails new requests but lets an open response keep streaming, so going offline alone
// never breaks a run. This wraps the run's response body so the spec can fail it the way a dropped connection does.
async function makeRunStreamCuttable(page: Page) {
  await page.addInitScript(() => {
    const realFetch = window.fetch.bind(window);
    let cut: (() => void) | null = null;
    (window as CutWindow).__cutRunStream = () => {
      if (!cut) return false;
      cut();
      return true;
    };
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const response = await realFetch(input, init);
      if (!url.endsWith('/agent/default/run') || !response.body) return response;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          cut = () => {
            cut = null;
            controller.error(new TypeError('network error'));
            void reader.cancel();
          };
          void (async () => {
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
              cut = null;
              controller.close();
            } catch {
              // Cut: the stream has already failed.
            }
          })();
        },
      });
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    };
  });
}

// Scenario 5 in a browser (ADR 015). Not run in CI's smoke tier: it needs the live stack and the model.
test('an offline blip mid-answer resumes, and a reload restores the conversation', async ({ page, context }) => {
  await makeRunStreamCuttable(page);
  await signIn(page, 'Ana Gómez');
  await ask(page, 'Explicame en cinco oraciones cómo funcionan las transferencias internacionales.');
  // The composer stays enabled while a run streams, so the run's end is read from the chat's running flag.
  const chat = page.locator('[data-copilot-running]').first();
  await expect(chat).toHaveAttribute('data-copilot-running', 'true');

  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => (window as CutWindow).__cutRunStream?.() ?? false)).toBe(true);
  const pill = page.getByRole('status').filter({ hasText: /Sin conexión|Reconectando/ });
  await expect(pill).toHaveText('Sin conexión. Reintentamos al reconectar.');
  await page.waitForTimeout(1_500);
  await context.setOffline(false);

  await expect(pill).toBeHidden({ timeout: 60_000 });
  await expect(chat).toHaveAttribute('data-copilot-running', 'false');
  const answer = page.getByTestId('copilot-assistant-message').last();
  await expect(answer).not.toBeEmpty();
  const resumed = (await answer.textContent()) ?? '';

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
