import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  BarChartView,
  CitationView,
  KeyValueListView,
  ListView,
  TableView,
} from '../../../src/features/genui/components/catalog-components';
import { formatMoney } from '../../../src/shared/lib/format-money';
import { textOf } from '../../support/html-text';

type WithChildren = ReactElement<{ children?: ReactNode }>;

/** The `<li>` elements of a rendered chart, read from the element tree: the server renderer ignores keys. */
function barItems(chart: ReactNode): ReactElement[] {
  const children = (node: ReactNode): ReactNode[] =>
    isValidElement(node) ? [(node as WithChildren).props.children].flat(2) : [];
  const list = children(chart).find((child) => isValidElement(child) && child.type === 'ul');
  return children(list).filter(isValidElement);
}

describe('catalog components', () => {
  it('renders bars scaled to the largest value, with money labels', () => {
    const html = renderToString(
      <BarChartView
        currency="ARS"
        bars={[
          { label: 'supermercado', value: 200 },
          { label: 'transporte', value: 50 },
        ]}
      />,
    );
    expect(html).toContain('width:100%');
    expect(html).toContain('width:25%');
    expect(textOf(html)).toContain(formatMoney(200, 'ARS'));
  });

  it('keeps bar keys unique when the model repeats a label', () => {
    const chart = BarChartView({
      bars: [
        { label: 'compras', value: 120 },
        { label: 'compras', value: 80 },
      ],
    });
    const keys = barItems(chart).map((item) => item.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });

  it('renders list items with trailing values', () => {
    const html = renderToString(<ListView items={[{ title: 'Super', trailing: '$ 10,00' }]} />);
    expect(html).toContain('Super');
    expect(textOf(html)).toContain('$ 10,00');
    expect(html).toContain('money__cents');
  });

  it('names each cited section', () => {
    const html = renderToString(
      <CitationView
        sources={[{ docId: 'comisiones', title: 'Comisiones', section: 'Transferencias', anchor: 'transferencias' }]}
      />,
    );
    expect(html).toContain('Comisiones');
    expect(html).toContain('Transferencias');
  });

  it('puts the cited section on its own line, under the document title', () => {
    const html = renderToString(
      <CitationView sources={[{ docId: 'comisiones', title: 'Comisiones', section: 'Transferencias' }]} />,
    );
    expect(html).toContain('<span class="gen-citations__title">Comisiones</span>');
    expect(html).toContain('<span class="gen-citations__section">Transferencias</span>');
    expect(html).toContain('aria-label="Fuentes"');
  });

  it('shows no section line when it repeats the title', () => {
    const html = renderToString(
      <CitationView sources={[{ docId: 'tarjetas', title: 'Tarjetas', section: 'Tarjetas' }]} />,
    );
    expect(html).not.toContain('gen-citations__section');
  });

  it('formats money in key-value rows and table cells, and leaves other text alone', () => {
    const kv = renderToString(<KeyValueListView items={[{ label: 'Total', value: '$ 1.000,00' }]} />);
    expect(kv).toContain('money__cents');
    const table = renderToString(<TableView columns={['Fecha', 'Monto']} rows={[['12/11', '+$ 500,00']]} />);
    expect(table).toContain('money--in');
    expect(textOf(table)).toContain('12/11');
  });
});

describe('formatMoney', () => {
  it('formats es-AR with currency symbols', () => {
    expect(formatMoney('1254300.50', 'ARS')).toMatch(/^\$ 1\.254\.300,50$/);
    expect(formatMoney(3820, 'USD')).toMatch(/^US\$ 3\.820,00$/);
  });
});
