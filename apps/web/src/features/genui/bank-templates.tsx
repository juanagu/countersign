import type { ReactActivityMessageRenderer } from '@copilotkit/react-core/v2';
import type { BankTemplate, TransferConfirmData, TransferReceiptData } from '@poc/contracts';
import templatesSchema from '@poc/contracts/schemas/bank-templates.json';
import type { ReactNode } from 'react';
import { z } from 'zod';
import { ApprovalPanel, ApprovalWaiting } from '../approval/approval-panel';
import { isResolved } from '../approval/lib/confirm-card-state';
import { ResolvedLine } from '../approval/resolved-line';
import { useConfirmCard } from '../approval/use-confirm-card';
import { formatMoney } from '../../shared/lib/format-money';
import { Money } from '../../shared/ui/money';
import { KeyValueListView } from './components/catalog-components';
import '../../shared/ui/card.css';
import './bank-templates.css';

/** Must match `ACTIVITY_TYPE` in `services/bot/app/genui/templates.py`. */
export const BANK_TEMPLATE_ACTIVITY = 'bank-template';

const templateSchema = z.fromJSONSchema(templatesSchema as Parameters<typeof z.fromJSONSchema>[0]);

/** `footer` is the approval step: the card itself only draws the draft, and never decides anything. */
function TransferConfirmCard({ data, footer }: { data: TransferConfirmData; footer?: ReactNode }) {
  const destination = [data.beneficiary.bank, data.beneficiary.account && `cuenta ${data.beneficiary.account}`]
    .filter(Boolean)
    .join(', ');
  return (
    <section className="bank-card" aria-label="Confirmar transferencia">
      <div className="bank-card__top">
        <span className="bank-card__status">Por confirmar</span>
      </div>
      <p className="bank-card__amount">
        <Money hero value={formatMoney(data.amount, data.currency)} />
      </p>
      <p className="bank-card__to">
        <span className="bank-card__name">
          a <strong>{data.beneficiary.name}</strong>
        </span>
        <span>{destination}</span>
      </p>
      <KeyValueListView
        items={[
          { label: 'Desde', value: `${data.sourceAccount.alias} ${data.sourceAccount.number}` },
          { label: 'Comisión', value: formatMoney(data.fee, data.currency) },
          { label: 'Total', value: formatMoney(data.total, data.currency) },
        ]}
      />
      {footer}
    </section>
  );
}

/** The confirm card in the thread: it follows the approval, and collapses to a line once the transfer is settled. */
function ConfirmCardInThread({ data }: { data: TransferConfirmData }) {
  const { state, decide } = useConfirmCard(data);
  if (isResolved(state)) return <ResolvedLine state={state} draft={data} />;
  const footer = decide ? (
    <ApprovalPanel draft={data} onDecide={decide} />
  ) : (
    <ApprovalWaiting expiresAt={data.expiresAt} />
  );
  return <TransferConfirmCard data={data} footer={footer} />;
}

function TransferReceiptCard({ data }: { data: TransferReceiptData }) {
  const when = new Date(data.executedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <section className="bank-card bank-card--done" aria-label="Comprobante de transferencia">
      <div className="bank-card__top">
        <span className="bank-card__status">Enviada</span>
      </div>
      <p className="bank-card__amount">
        <Money hero value={formatMoney(data.amount, data.currency)} />
      </p>
      <p className="bank-card__to">
        <span className="bank-card__name">
          a <strong>{data.beneficiary.name}</strong>
        </span>
      </p>
      <KeyValueListView
        items={[
          { label: 'Comprobante', value: data.reference },
          { label: 'Fecha', value: when },
          { label: 'Desde', value: `${data.sourceAccount.alias} ${data.sourceAccount.number}` },
          { label: 'Comisión', value: formatMoney(data.fee, data.currency) },
        ]}
      />
    </section>
  );
}

/** The templates as drawn, with no approval behind them. */
export function BankTemplateView({ template }: { template: BankTemplate }) {
  if (template.template === 'transfer-confirm') return <TransferConfirmCard data={template.data} />;
  return <TransferReceiptCard data={template.data} />;
}

function BankTemplateInThread({ template }: { template: BankTemplate }) {
  if (template.template === 'transfer-confirm') return <ConfirmCardInThread data={template.data} />;
  return <TransferReceiptCard data={template.data} />;
}

export const bankTemplateRenderer: ReactActivityMessageRenderer<BankTemplate> = {
  activityType: BANK_TEMPLATE_ACTIVITY,
  content: templateSchema as unknown as ReactActivityMessageRenderer<BankTemplate>['content'],
  render: ({ content }) => <BankTemplateInThread template={content} />,
};
