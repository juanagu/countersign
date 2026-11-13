import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../src/app';

describe('App', () => {
  it('renders the assistant title', () => {
    expect(renderToString(<App />)).toContain('Asistente bancario');
  });
});
