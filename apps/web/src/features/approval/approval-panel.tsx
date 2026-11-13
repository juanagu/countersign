import type { TransferConfirmData } from '@poc/contracts';
import { useRef, useState } from 'react';
import { formatMoney } from '../../shared/lib/format-money';
import { Button } from '../../shared/ui/button';
import {
  cancelTransfer,
  confirmTransfer,
  type ApprovalError,
  type DecisionResult,
  type OnDecide,
} from './lib/approval-decision';
import { requestStepUp } from './lib/step-up-api';
import { PinDialog, RESUME_FAILED_MESSAGE } from './pin-dialog';
import './approval.css';

export type { ApprovalDecision } from './lib/approval-decision';

export interface ApprovalPanelProps {
  draft: TransferConfirmData | undefined;
  onDecide: OnDecide;
}

export function ApprovalPanel({ draft, onDecide }: ApprovalPanelProps) {
  const [askingPin, setAskingPin] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApprovalError | null>(null);
  const [cancelFailed, setCancelFailed] = useState(false);
  // A new key remounts the dialog with an empty PIN: a token spent by a failed resume can't be reused.
  const [pinAttempt, setPinAttempt] = useState(0);
  const inFlight = useRef(false);

  function onConfirmed(result: DecisionResult) {
    if (result.kind !== 'failed') return;
    setError(result.error);
    if (result.error === 'resume_failed') setPinAttempt((attempt) => attempt + 1);
  }

  async function confirm(pin: string) {
    if (!draft) return;
    setPending(true);
    setError(null);
    try {
      onConfirmed(await confirmTransfer(inFlight, draft, pin, { stepUp: requestStepUp, onDecide }));
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    setCancelFailed(false);
    const result = await cancelTransfer(inFlight, onDecide);
    setCancelFailed(result.kind === 'failed');
  }

  const cancelError = cancelFailed && (
    <p role="alert" className="approval__error">
      {RESUME_FAILED_MESSAGE}
    </p>
  );

  if (!draft) {
    return (
      <div className="approval">
        <p>No encontramos el borrador de esta transferencia.</p>
        {cancelError}
        <Button variant="secondary" onClick={() => void cancel()}>
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
      {cancelError}
      <div className="approval__actions">
        <Button variant="secondary" onClick={() => void cancel()}>
          Cancelar
        </Button>
        <Button onClick={() => setAskingPin(true)}>Confirmar</Button>
      </div>
      {askingPin && (
        <PinDialog
          key={pinAttempt}
          pending={pending}
          error={error}
          onSubmit={(pin) => void confirm(pin)}
          onClose={() => setAskingPin(false)}
        />
      )}
    </div>
  );
}
