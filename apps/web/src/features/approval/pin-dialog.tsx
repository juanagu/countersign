import type { TransferConfirmData } from '@poc/contracts';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatMoney } from '../../shared/lib/format-money';
import { Button } from '../../shared/ui/button';
import { Icon } from '../../shared/ui/icon';
import { Money } from '../../shared/ui/money';
import type { ApprovalError } from './lib/approval-decision';
import { canSubmitPin, PIN_LENGTH } from './lib/pin-entry';
import './pin-dialog.css';

const MESSAGES: Record<ApprovalError, string> = {
  invalid_pin: 'El PIN no es correcto.',
  locked: 'Demasiados intentos. Esperá 5 minutos y volvé a probar.',
  failed: 'No pudimos verificar tu identidad. Probá de nuevo.',
};

export interface PinDialogProps {
  /** The draft being confirmed, read from its server template: the summary never comes from model text. */
  draft: TransferConfirmData;
  onSubmit: (pin: string) => void;
  onPinChange: () => void;
  onClose: () => void;
  pending: boolean;
  error: ApprovalError | null;
}

/** Step-up PIN entry. App chrome, not an A2UI component: the catalog has no secret inputs. */
export function PinDialog({ draft, onSubmit, onPinChange, onClose, pending, error }: PinDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pin, setPin] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (canSubmitPin(pin, pending, error)) onSubmit(pin);
  }

  // Closing through the dialog (not by unmounting it) hands focus back to the button that opened it.
  const goBack = () => dialog.current?.close();

  return (
    <dialog ref={dialog} className="pin-dialog" onClose={onClose} aria-labelledby="pin-title">
      <form method="dialog" onSubmit={submit} className="pin-dialog__form">
        <span className="pin-dialog__handle" aria-hidden="true" />
        <h2 id="pin-title" className="pin-dialog__title">
          Confirmá con tu PIN
        </h2>
        <p className="pin-dialog__summary">
          <span>Transferís</span>{' '}
          <strong>
            <Money value={formatMoney(draft.amount, draft.currency)} />
          </strong>{' '}
          <span>a {draft.beneficiary.name}</span>
        </p>
        <label htmlFor="pin-input" className="pin-dialog__label">
          PIN de {PIN_LENGTH} dígitos
        </label>
        <input
          id="pin-input"
          className="pin-dialog__input"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern={`[0-9]{${PIN_LENGTH}}`}
          maxLength={PIN_LENGTH}
          value={pin}
          onChange={(event) => {
            setPin(event.target.value.replace(/\D/g, ''));
            onPinChange();
          }}
          disabled={pending}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'pin-error' : undefined}
          autoFocus
        />
        {error && (
          <p id="pin-error" role="alert" className="pin-dialog__error">
            <Icon name="alert" size={16} />
            <span>{MESSAGES[error]}</span>
          </p>
        )}
        <div className="pin-dialog__actions">
          <Button variant="ghost" onClick={goBack} disabled={pending}>
            Volver
          </Button>
          <Button type="submit" disabled={!canSubmitPin(pin, pending, error)}>
            {pending ? 'Verificando…' : 'Confirmar'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
