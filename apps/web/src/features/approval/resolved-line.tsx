import type { TransferConfirmData } from '@poc/contracts';
import { formatMoney } from '../../shared/lib/format-money';
import { Icon, type IconName } from '../../shared/ui/icon';
import { RESUME_FAILED_NOTICE } from './lib/resume-outcome';
import type { ResolvedState } from './lib/confirm-card-state';
import './approval.css';

interface Line {
  icon: IconName;
  tone: 'positive' | 'neutral' | 'danger';
  text: string;
}

function lineFor(state: ResolvedState, draft: TransferConfirmData): Line {
  const transfer = `de ${formatMoney(draft.amount, draft.currency)} a ${draft.beneficiary.name}`;
  switch (state) {
    case 'confirmed':
      return { icon: 'check', tone: 'positive', text: 'Confirmaste la transferencia con tu PIN.' };
    case 'expired':
      return { icon: 'clock', tone: 'neutral', text: `La transferencia ${transfer} venció sin confirmarse.` };
    case 'resume-failed':
      return { icon: 'alert', tone: 'danger', text: RESUME_FAILED_NOTICE };
    case 'not-sent':
      return { icon: 'cross', tone: 'neutral', text: `No se envió la transferencia ${transfer}.` };
  }
}

/** What a confirm card collapses to once the transfer is decided: one muted line, never the draft's figures again. */
export function ResolvedLine({ state, draft }: { state: ResolvedState; draft: TransferConfirmData }) {
  const { icon, tone, text } = lineFor(state, draft);
  return (
    <p className={`resolved resolved--${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon} size={18} />
      <span>{text}</span>
    </p>
  );
}
