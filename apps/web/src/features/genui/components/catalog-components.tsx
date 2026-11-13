import type {
  BarChartProps,
  ButtonProps,
  CitationProps,
  KeyValueListProps,
  ListProps,
  QuickRepliesProps,
  TableProps,
  TextProps,
} from '@poc/contracts';
import { Button } from '../../../shared/ui/button';
import { formatMoney } from '../../../shared/lib/format-money';
import { useChatActions } from '../chat-actions';
import './catalog-components.css';

export function TextView({ text, variant = 'body' }: TextProps) {
  if (variant === 'heading') return <h3 className="gen-text gen-text--heading">{text}</h3>;
  return <p className={`gen-text gen-text--${variant}`}>{text}</p>;
}

export function KeyValueListView({ items }: KeyValueListProps) {
  return (
    <dl className="gen-kv">
      {items.map((item) => (
        <div key={item.label} className="gen-kv__row">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ListView({ items }: ListProps) {
  return (
    <ul className="gen-list">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`} className="gen-list__item">
          <span className="gen-list__main">
            <span className="gen-list__title">{item.title}</span>
            {item.subtitle && <span className="gen-list__subtitle">{item.subtitle}</span>}
          </span>
          {item.trailing && <span className="gen-list__trailing">{item.trailing}</span>}
        </li>
      ))}
    </ul>
  );
}

export function BarChartView({ title, currency, bars }: BarChartProps) {
  const max = Math.max(...bars.map((bar) => bar.value), 1);
  const label = (value: number) => (currency ? formatMoney(value, currency) : value.toLocaleString('es-AR'));
  return (
    <figure className="gen-chart">
      {title && <figcaption className="gen-chart__title">{title}</figcaption>}
      <ul className="gen-chart__bars">
        {/* The model may repeat a label (e.g. one category in two currencies); the index keeps keys unique. */}
        {bars.map((bar, index) => (
          <li key={`${index}-${bar.label}`} className="gen-chart__bar">
            <span className="gen-chart__label">{bar.label}</span>
            <span className="gen-chart__track" aria-hidden="true">
              <span className="gen-chart__fill" style={{ width: `${(bar.value / max) * 100}%` }} />
            </span>
            <span className="gen-chart__value">{label(bar.value)}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}

export function TableView({ columns, rows }: TableProps) {
  return (
    <div className="gen-table-wrap">
      <table className="gen-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ButtonView({ label, message }: ButtonProps) {
  const { sendMessage } = useChatActions();
  return (
    <Button variant="secondary" onClick={() => sendMessage(message)}>
      {label}
    </Button>
  );
}

export function QuickRepliesView({ options }: QuickRepliesProps) {
  const { sendMessage } = useChatActions();
  return (
    <div className="gen-replies" role="group" aria-label="Respuestas rápidas">
      {options.map((option) => (
        <Button key={option.label} variant="secondary" onClick={() => sendMessage(option.message)}>
          {option.label}
        </Button>
      ))}
    </div>
  );
}

/** Citations name the knowledge-base section; there is no public KB page to link to in the POC. */
export function CitationView({ sources }: CitationProps) {
  return (
    <aside className="gen-citations" aria-label="Fuentes">
      <span className="gen-citations__label">Fuentes</span>
      <ol className="gen-citations__list">
        {sources.map((source) => (
          <li key={`${source.docId}#${source.anchor ?? ''}`} title={`${source.docId}#${source.anchor ?? ''}`}>
            {source.title}
            {source.section && source.section !== source.title && <> — {source.section}</>}
          </li>
        ))}
      </ol>
    </aside>
  );
}
