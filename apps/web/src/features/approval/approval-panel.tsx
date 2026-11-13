import type { TransferConfirmData } from '@poc/contracts';
import { useRef, useState } from 'react';
import { formatMoney } from '../../shared/lib/format-money';
import { Button } from '../../shared/ui/button';
import { requestStepUp, StepUpFailed, type StepUpError } from './lib/step-up-api';
import { PinDialog } from './pin-dialog';
import './approval.css';

/** The resume payload Pydantic AI expects: `editedArgs` replaces the tool call's arguments. */
export interface ApprovalDecision {
  approved: boolean;
  editedArgs?: { draft_id: string; step_up_token: string };
  reason?: string;
}

export interface ApprovalPanelProps {
  draft: TransferConfirmData | undefined;
  onDecide: (decision: ApprovalDecision) => Promise<unknown>;
}

export function ApprovalPanel({ draft, onDecide }: ApprovalPanelProps) {
  const [askingPin, setAskingPin] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<StepUpError | null>(null);
  // A ref, not state: a double click lands before React re-renders the disabled button.
  const decided = useRef(false);

  async function decide(decision: ApprovalDecision) {
    if (decided.current) return;
    decided.current = true;
    await onDecide(decision);
  }

  async function confirm(pin: string) {
    if (!draft || decided.current) return;
    setPending(true);
    setError(null);
    try {
      const token = await requestStepUp(draft, pin);
      await decide({ approved: true, editedArgs: { draft_id: draft.draftId, step_up_token: token } });
    } catch (failure) {
      setError(failure instanceof StepUpFailed ? failure.reason : 'failed');
    } finally {
      setPending(false);
    }
  }

  const cancel = () => void decide({ approved: false, reason: 'El cliente canceló la transferencia.' });

  if (!draft) {
    return (
      <div className="approval">
        <p>No encontramos el borrador de esta transferencia.</p>
        <Button variant="secondary" onClick={cancel}>
          Descartar
        </Button>
      </div>
    );
  }

  return (
    <div className="approval" role="group" aria-label="Aprobar transferencia">
      <p className="approval__question">
        ¿Transferir <strong>{formatMoney(draft.total, draft.currency)}</strong> a {draft.beneficiary.name}?
      </p>
      <div className="approval__actions">
        <Button variant="secondary" onClick={cancel}>
          Cancelar
        </Button>
        <Button onClick={() => setAskingPin(true)}>Confirmar</Button>
      </div>
      {askingPin && (
        <PinDialog
          pending={pending}
          error={error}
          onSubmit={(pin) => void confirm(pin)}
          onClose={() => setAskingPin(false)}
        />
      )}
    </div>
  );
}
