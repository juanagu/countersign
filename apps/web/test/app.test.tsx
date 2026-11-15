import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app';

describe('App', () => {
  it('shows a loading state before the session is known', () => {
    expect(renderToString(<App />)).toContain('Cargando');
  });

  it('shows the login screen when signed out', () => {
    expect(renderToString(<App initialState={{ status: 'signed-out' }} />)).toContain('Elegí con qué cliente entrar');
  });
});
