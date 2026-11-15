import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Money } from '../../../src/shared/ui/money';
import { textOf } from '../../support/html-text';

const render = (value: string, hero = false) => renderToStaticMarkup(<Money value={value} hero={hero} />);

describe('Money', () => {
  it('mutes the cents of a pesos amount and keeps the text whole', () => {
    const html = render('$ 380.000,00');
    expect(html).toContain('<span class="money__cents">,00</span>');
    expect(textOf(html)).toBe('$ 380.000,00');
  });

  it('splits dollar amounts too', () => {
    const html = render('US$ 3.820,50');
    expect(html).toContain('<span class="money__cents">,50</span>');
    expect(textOf(html)).toBe('US$ 3.820,50');
  });

  it('colours an incoming amount, the sign included', () => {
    const html = render('+$ 1.500,00');
    expect(html).toContain('money--in');
    expect(textOf(html)).toBe('+$ 1.500,00');
  });

  it('does not colour an outgoing amount', () => {
    expect(render('-$ 1.500,00')).not.toContain('money--in');
    expect(render('−$ 1.500,00')).not.toContain('money--in');
  });

  it.each(['Cargo US$ 30 (mínimo)', '12/11/26', '$ 1.000', '$ 1.000,5', 'Banco Demo ••••5211', ''])(
    'renders %j unchanged',
    (text) => {
      const html = render(text);
      expect(html).not.toContain('money__cents');
      expect(textOf(html)).toBe(text);
    },
  );

  it('takes the hero size for the transfer amount, even when the text is not money', () => {
    expect(render('$ 50.000,00', true)).toContain('money--hero');
    expect(render('pendiente', true)).toContain('money--hero');
  });
});
