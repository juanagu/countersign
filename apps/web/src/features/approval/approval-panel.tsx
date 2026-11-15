import type { TransferConfirmData } from '@poc/contracts';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
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

/** "Válida hasta las 09:42": the draft's lifetime, read from the server template. */
export function ApprovalNote({ expiresAt }: { expiresAt: string }) {
  const time = new Date(expiresAt).toLocaleTimeString('es-AR', {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return (
    <p className="card__note">
      <Icon name="clock" size={16} />
      <span>Válida hasta las {time}</span>
    </p>
  );
}

/** The confirm card's footer while the transfer awaits the customer: no buttons, as nothing can be answered. */
export function ApprovalWaiting({ expiresAt }: { expiresAt: string }) {
  return (
    <div className="card__foot">
      <ApprovalNote expiresAt={expiresAt} />
    </div>
  );
}

export interface ApprovalPanelProps {
  draft: TransferConfirmData;
  onDecide: OnDecide;
}

/** The confirm card's footer: Cancelar and Confirmar, and the PIN step-up Confirmar opens. */
export function ApprovalPanel({ draft, onDecide }: ApprovalPanelProps) {
  const [askingPin, setAskingPin] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApprovalError | null>(null);
  const inFlight = useRef(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const wasAsking = useRef(false);

  // The buttons are disabled while the PIN sheet is open, so the sheet can't hand focus back to Confirmar itself.
  useEffect(() => {
    if (wasAsking.current && !askingPin) confirmButton.current?.focus();
    wasAsking.current = askingPin;
  }, [askingPin]);

  const onPin = (event: PinEvent) => setError(pinErrorAfter(event));

  function onConfirmed(result: DecisionResult) {
    if (result.kind === 'failed') onPin({ type: 'failed', error: result.error });
  }

  function openPin() {
    onPin({ type: 'opened' });
    setAskingPin(true);
  }

  async function confirm(pin: string) {
    setPending(true);
    setError(null);
    try {
      onConfirmed(await confirmTransfer(inFlight, draft, pin, { stepUp: requestStepUp, onDecide }));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="card__foot">
      <ApprovalNote expiresAt={draft.expiresAt} />
      <div className="card__actions">
        <Button variant="secondary" onClick={() => void cancelTransfer(inFlight, onDecide)} disabled={askingPin}>
          Cancelar
        </Button>
        <Button ref={confirmButton} onClick={openPin} disabled={askingPin}>
          Confirmar
        </Button>
      </div>
      {askingPin && (
        <PinDialog
          draft={draft}
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
