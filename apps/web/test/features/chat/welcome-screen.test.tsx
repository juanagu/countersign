import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { WelcomeNameContext, WelcomeScreen } from '../../../src/features/chat/welcome-screen';
import { WELCOME_TILES } from '../../../src/features/chat/welcome-tiles';

vi.mock('../../../src/features/genui/chat-actions', () => ({ useChatActions: () => ({ sendMessage: vi.fn() }) }));

describe('welcome tiles', () => {
  it('sends a real question for each shortcut', () => {
    expect(WELCOME_TILES).toHaveLength(6);
    for (const tile of WELCOME_TILES) {
      expect(tile.label.length).toBeGreaterThan(0);
      expect(tile.message.length).toBeGreaterThan(tile.label.length - 1);
    }
    expect(WELCOME_TILES.map((tile) => tile.message)).toContain('Quiero hacer una transferencia');
  });

  it('keeps labels unique, since the tiles are keyed by them', () => {
    expect(new Set(WELCOME_TILES.map((tile) => tile.label)).size).toBe(WELCOME_TILES.length);
  });
});

describe('welcome screen markup', () => {
  it('lists the tiles as buttons in a list, under a greeting by first name', () => {
    const html = renderToStaticMarkup(
      <WelcomeNameContext.Provider value="Ana">
        <WelcomeScreen input={<div data-testid="composer" />} suggestionView={<></>} />
      </WelcomeNameContext.Provider>,
    );
    expect(html).toContain('Hola, Ana');
    expect(html).toContain('¿Qué querés resolver hoy?');
    expect(html.match(/<li>/g)).toHaveLength(6);
    expect(html.match(/<button/g)).toHaveLength(6);
    expect(html).toContain('data-testid="composer"');
  });
});
