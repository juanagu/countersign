import { createA2UICatalog, type A2UIComponentDefinition, type A2UIComponentMap } from '@copilotkit/a2ui-renderer';
import type { CardProps } from '@poc/contracts';
import catalogSchema from '@poc/contracts/schemas/a2ui-catalog.json';
import type { ComponentType, ReactNode } from 'react';
import { z } from 'zod';
import {
  BarChartView,
  ButtonView,
  CitationView,
  KeyValueListView,
  ListView,
  QuickRepliesView,
  TableView,
  TextView,
} from './components/catalog-components';
import '../../shared/ui/card.css';

/** Must match `CATALOG_ID` in the bot (`services/bot/app/genui/a2ui.py`). */
export const CATALOG_ID = 'bank-catalog-v1';

type PropsName = keyof typeof catalogSchema.$defs & `${string}Props`;
type Renderer<P> = (args: { props: P; children: (id: string) => ReactNode }) => ReactNode;

/**
 * One component of the catalog. Its props schema comes from the contract (zod 4 `fromJSONSchema`), so the
 * renderer accepts exactly what the bot validated. The renderer's types target zod's v3 API; at runtime it
 * only calls `safeParse`, which both share, hence the single cast here.
 */
function component<P>(name: PropsName, render: Renderer<P>): A2UIComponentDefinition {
  const props = z.fromJSONSchema(catalogSchema.$defs[name] as Parameters<typeof z.fromJSONSchema>[0]);
  return { props, render } as unknown as A2UIComponentDefinition;
}

function leaf<P extends object>(name: PropsName, View: ComponentType<P>): A2UIComponentDefinition {
  return component<P>(name, ({ props }) => <View {...props} />);
}

function CardView({ props, children }: { props: CardProps; children: (id: string) => ReactNode }) {
  return (
    <section className="gen-card">
      {(props.title || props.subtitle) && (
        <header className="gen-card__head">
          {props.title && <h2 className="gen-card__title">{props.title}</h2>}
          {props.subtitle && <p className="gen-card__subtitle">{props.subtitle}</p>}
        </header>
      )}
      {props.children.map((id) => (
        <div key={id} className="gen-card__item">
          {children(id)}
        </div>
      ))}
    </section>
  );
}

const components: A2UIComponentMap = {
  Card: component<CardProps>('CardProps', CardView),
  Text: leaf('TextProps', TextView),
  KeyValueList: leaf('KeyValueListProps', KeyValueListView),
  List: leaf('ListProps', ListView),
  BarChart: leaf('BarChartProps', BarChartView),
  Table: leaf('TableProps', TableView),
  Button: leaf('ButtonProps', ButtonView),
  Citation: leaf('CitationProps', CitationView),
  QuickReplies: leaf('QuickRepliesProps', QuickRepliesView),
};

export const bankCatalog = createA2UICatalog(components, { catalogId: CATALOG_ID, includeBasicCatalog: false });
