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
import { pinErrorAfter, type PinEvent } from './lib/pin-entry';
import { requestStepUp } from './lib/step-up-api';
import { PinDialog } from './pin-dialog';
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
  const inFlight = useRef(false);

  const onPin = (event: PinEvent) => setError(pinErrorAfter(event));

  function onConfirmed(result: DecisionResult) {
    if (result.kind === 'failed') onPin({ type: 'failed', error: result.error });
  }

  function openPin() {
    onPin({ type: 'opened' });
    setAskingPin(true);
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

  function cancel() {
    void cancelTransfer(inFlight, onDecide);
  }

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
        <Button onClick={openPin}>Confirmar</Button>
      </div>
      {askingPin && (
        <PinDialog
          pending={pending}
          error={error}
          onSubmit={(pin) => void confirm(pin)}
          onPinChange={() => onPin({ type: 'pin_changed' })}
          onClose={() => setAskingPin(false)}
        />
      )}
    </div>
  );
}
