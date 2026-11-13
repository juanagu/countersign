import type { ReactActivityMessageRenderer } from '@copilotkit/react-core/v2';
import type { BankTemplate, TransferConfirmData, TransferReceiptData } from '@poc/contracts';
import templatesSchema from '@poc/contracts/schemas/bank-templates.json';
import { z } from 'zod';
import { formatMoney } from '../../shared/lib/format-money';
import { KeyValueListView } from './components/catalog-components';
import './bank-templates.css';

/** Must match `ACTIVITY_TYPE` in `services/bot/app/genui/templates.py`. */
export const BANK_TEMPLATE_ACTIVITY = 'bank-template';

const templateSchema = z.fromJSONSchema(templatesSchema as Parameters<typeof z.fromJSONSchema>[0]);

function TransferConfirmCard({ data }: { data: TransferConfirmData }) {
  const expires = new Date(data.expiresAt).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
  return (
    <section className="bank-card" aria-label="Confirmar transferencia">
      <p className="bank-card__eyebrow">Transferencia por confirmar</p>
      <p className="bank-card__amount">{formatMoney(data.amount, data.currency)}</p>
      <p className="bank-card__to">a {data.beneficiary.name}</p>
      <KeyValueListView
        items={[
          { label: 'Destino', value: `${data.beneficiary.bank ?? ''} ${data.beneficiary.account}`.trim() },
          { label: 'Desde', value: `${data.sourceAccount.alias} ${data.sourceAccount.number}` },
          { label: 'Comisión', value: formatMoney(data.fee, data.currency) },
          { label: 'Total', value: formatMoney(data.total, data.currency) },
        ]}
      />
      <p className="bank-card__note">Válida hasta las {expires}. Nada se envía sin tu confirmación.</p>
    </section>
  );
}

function TransferReceiptCard({ data }: { data: TransferReceiptData }) {
  const when = new Date(data.executedAt).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  return (
    <section className="bank-card bank-card--done" aria-label="Comprobante de transferencia">
      <p className="bank-card__eyebrow">Transferencia enviada</p>
      <p className="bank-card__amount">{formatMoney(data.amount, data.currency)}</p>
      <p className="bank-card__to">a {data.beneficiary.name}</p>
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

export function BankTemplateView({ template }: { template: BankTemplate }) {
  if (template.template === 'transfer-confirm') return <TransferConfirmCard data={template.data} />;
  return <TransferReceiptCard data={template.data} />;
}

export const bankTemplateRenderer: ReactActivityMessageRenderer<BankTemplate> = {
  activityType: BANK_TEMPLATE_ACTIVITY,
  content: templateSchema as unknown as ReactActivityMessageRenderer<BankTemplate>['content'],
  render: ({ content }) => <BankTemplateView template={content} />,
};
