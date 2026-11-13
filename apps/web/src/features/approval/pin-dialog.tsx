import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../shared/ui/button';
import type { ApprovalError } from './lib/approval-decision';

const MESSAGES: Record<ApprovalError, string> = {
  invalid_pin: 'El PIN no es correcto.',
  locked: 'Demasiados intentos. Esperá unos minutos y volvé a probar.',
  failed: 'No pudimos verificar tu identidad. Probá de nuevo.',
};

export interface PinDialogProps {
  onSubmit: (pin: string) => void;
  onClose: () => void;
  pending: boolean;
  error: ApprovalError | null;
}

/** Step-up PIN entry. App chrome, not an A2UI component: the catalog has no secret inputs. */
export function PinDialog({ onSubmit, onClose, pending, error }: PinDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [pin, setPin] = useState('');

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pin.length === 6 && !pending) onSubmit(pin);
  }

  return (
    <dialog ref={dialog} className="pin-dialog" onClose={onClose} aria-labelledby="pin-title">
      <form method="dialog" onSubmit={submit} className="pin-dialog__form">
        <h2 id="pin-title" className="pin-dialog__title">
          Confirmá con tu PIN
        </h2>
        <label htmlFor="pin-input" className="muted">
          PIN de 6 dígitos
        </label>
        <input
          id="pin-input"
          className="pin-dialog__input"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
          disabled={pending}
          autoFocus
        />
        {error && (
          <p role="alert" className="pin-dialog__error">
            {MESSAGES[error]}
          </p>
        )}
        <div className="pin-dialog__actions">
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Volver
          </Button>
          <Button type="submit" disabled={pending || pin.length !== 6 || error === 'locked'}>
            {pending ? 'Verificando…' : 'Confirmar'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
