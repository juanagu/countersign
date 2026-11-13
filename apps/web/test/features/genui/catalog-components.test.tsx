import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BarChartView, CitationView, ListView } from '../../../src/features/genui/components/catalog-components';
import { formatMoney } from '../../../src/shared/lib/format-money';

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
    expect(html).toContain(formatMoney(200, 'ARS'));
  });

  it('renders list items with trailing values', () => {
    const html = renderToString(<ListView items={[{ title: 'Super', trailing: '$ 10,00' }]} />);
    expect(html).toContain('Super');
    expect(html).toContain('$ 10,00');
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
});

describe('formatMoney', () => {
  it('formats es-AR with currency symbols', () => {
    expect(formatMoney('1254300.50', 'ARS')).toMatch(/^\$ 1\.254\.300,50$/);
    expect(formatMoney(3820, 'USD')).toMatch(/^US\$ 3\.820,00$/);
  });
});
